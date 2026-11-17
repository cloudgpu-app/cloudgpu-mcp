import os,time,pathlib,json,subprocess,hashlib
started=time.monotonic()
import torch
if not torch.cuda.is_available():raise RuntimeError('CUDA required')
from safetensors.torch import load_file
OUT=pathlib.Path(os.environ['CLOUDGPU_OUTPUT_DIR']);OUT.mkdir(mode=0o700,parents=True,exist_ok=True)
data=pathlib.Path.cwd()/'acceptance-text.jsonl'
texts=['A small cloud GPU can run a bounded training task and save its results.','The synthetic dataset contains no customer information or private text.','A low rank adapter changes a small number of trainable parameters.','Always release the GPU after the task finishes and verify its cost.']
data.write_text(''.join(json.dumps({'text':text})+chr(10) for text in texts))
import importlib.util,json,math,os,pathlib,stat

def training_dtype(torch):
    # Device capability alone does not guarantee the installed torch CUDA kernels.
    if not torch.cuda.is_bf16_supported(): return torch.float32
    try:
        torch.triu(torch.ones((2,2),device='cuda',dtype=torch.bfloat16),diagonal=1)
    except RuntimeError as error:
        if 'not implemented' not in str(error): raise
        return torch.float32
    return torch.bfloat16

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
    dtype=training_dtype(torch)
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
    return {'task':'causal-lm-lora','steps_completed':options['steps'],'records':len(texts),'last_loss':loss_value,'base_model':ref['repo_id'],'revision':ref['revision'],'rank':options['rank'],'training_dtype':str(dtype)}

options={'dataset_path':str(data),'model_reference':{'name': 'smollm', 'repo_id': 'HuggingFaceTB/SmolLM2-135M', 'revision': '93efa2f097d58c2a74874c7e644dbc9b0cee75a2', 'files': [{'path': 'config.json', 'size_bytes': 704, 'sha256': '1d556eab73b69c7f11f64c557a2f9c6f440bd4c6b89bb2584a6b498c92603843'}, {'path': 'generation_config.json', 'size_bytes': 111, 'sha256': '2056c988e990b0d13670f63f2f3b87b3b6d07edaf7a3416998ba27dab2d8a059'}, {'path': 'model.safetensors', 'size_bytes': 269060552, 'sha256': '80521b40281d6ce74e35c9282c22539e75aa0ac8578892b2a59955ef78d55da1'}, {'path': 'special_tokens_map.json', 'size_bytes': 831, 'sha256': 'e786b595b9a23148bf1630df78d9037a048ea671e48bfd3549a1e3c233742bb3'}, {'path': 'tokenizer.json', 'size_bytes': 2104556, 'sha256': '9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c'}, {'path': 'tokenizer_config.json', 'size_bytes': 3658, 'sha256': '4bb9af56a342753d39374f4016a16574cab299fe088e896f425ce3c433f61424'}]},'rank':4,'target_modules':['q_proj','v_proj'],'steps':8,'learning_rate':0.0002,'sequence_length':64}
def local_file(path,limit):
 p=pathlib.Path(path).resolve();assert p==data.resolve() and p.is_file() and not p.is_symlink() and p.stat().st_size<=limit;return p
result=run(options,local_file,OUT)
weights=load_file(str(OUT/'adapter_model.safetensors'))
result['nonzero_trained_lora_B']=any('lora_B' in name and float(tensor.abs().sum())>0 for name,tensor in weights.items())
assert result['nonzero_trained_lora_B'],'adapter did not update'
result.update({'status':'passed','cuda_available':True,'gpu':torch.cuda.get_device_name(0),'training_and_save_seconds':round(time.monotonic()-started,6),'adapter_bytes':(OUT/'adapter_model.safetensors').stat().st_size,'scope':'8-step synthetic-text causal-LM LoRA smoke test; not image LoRA or a quality benchmark'})
(OUT/'lora-acceptance.json').write_text(json.dumps(result))
print('LORA_CUDA_ACCEPTANCE_OK '+json.dumps(result))
