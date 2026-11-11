import importlib.util,json,math,os,pathlib,stat

def run(options, project_file, output_dir):
    # Reuse a reviewed image; do not reinstall CUDA/torch or run remote model code.
    if any(importlib.util.find_spec(m) is None for m in ['torch','transformers','peft','safetensors']):
        raise ValueError('Select an image with torch, transformers, peft and safetensors installed')
    import torch
    from transformers import AutoTokenizer,AutoModelForCausalLM
    from peft import LoraConfig,get_peft_model
    if not torch.cuda.is_available(): raise ValueError('A CUDA training environment is required')
    source=project_file(options['dataset_path'],33554432)
    texts=[]
    with source.open(encoding='utf-8') as f:
        for line in f:
            if len(texts)>=1000: raise ValueError('Dataset exceeds 1000 records')
            row=json.loads(line);text=row.get('text') if isinstance(row,dict) else None
            if not isinstance(text,str) or not text.strip() or len(text)>8192: raise ValueError('Use JSONL records with a bounded text field')
            texts.append(text)
    if not texts: raise ValueError('Dataset is empty')
    ref=options['model_reference']
    model_root=pathlib.Path(os.environ['CLOUDGPU_MODEL_DIR']).resolve()/ref['name']
    if not model_root.is_dir() or model_root.is_symlink(): raise ValueError('Pinned model directory is unavailable')
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    torch.manual_seed(0)
    tokenizer=AutoTokenizer.from_pretrained(str(model_root),local_files_only=True,trust_remote_code=False)
    dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    model=AutoModelForCausalLM.from_pretrained(str(model_root),local_files_only=True,trust_remote_code=False,torch_dtype=dtype).to('cuda')
    model=get_peft_model(model,LoraConfig(r=options['rank'],lora_alpha=options['rank']*2,lora_dropout=0.05,bias='none',task_type='CAUSAL_LM',target_modules=options['target_modules']))
    model.train();optimizer=torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),lr=options['learning_rate'])
    loss_value=None
    for step in range(options['steps']):
        batch=tokenizer(texts[step%len(texts)],return_tensors='pt',truncation=True,max_length=options['sequence_length'])
        if batch['input_ids'].shape[-1]<2: raise ValueError('Training record has too few tokens')
        batch={k:v.to('cuda') for k,v in batch.items()};batch['labels']=batch['input_ids'].clone()
        optimizer.zero_grad(set_to_none=True);loss=model(**batch).loss
        loss_value=float(loss.detach().float().cpu())
        if not math.isfinite(loss_value): raise ValueError('Training loss is not finite')
        loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.0);optimizer.step()
    model.peft_config['default'].base_model_name_or_path=ref['repo_id']
    model.peft_config['default'].revision=ref['revision']
    model.save_pretrained(str(output_dir),safe_serialization=True)
    for name in ['adapter_config.json','adapter_model.safetensors']:
        p=output_dir/name
        if p.is_symlink() or not stat.S_ISREG(p.stat().st_mode) or p.stat().st_size<=0:
            raise ValueError('Expected adapter output missing')
    return {'task':'causal-lm-lora','steps_completed':options['steps'],'records':len(texts),'last_loss':loss_value,'base_model':ref['repo_id'],'revision':ref['revision'],'rank':options['rank']}
