import os,pathlib,json,wave,stat

def run(options,project_file,out):
    # The Job's model loader has already verified the pinned file manifest.
    # Reuse prepared dependencies; no remote code or implicit model downloads.
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    import torch
    if not torch.cuda.is_available(): raise ValueError('CUDA is required')
    ref=options['model_reference']
    root=pathlib.Path(os.environ['CLOUDGPU_MODEL_DIR']).resolve()/ref['name']
    if root.is_symlink() or not root.is_dir(): raise ValueError('Pinned model unavailable')
    source=project_file(options['input_path'],1048576)
    common={'local_files_only':True,'trust_remote_code':False}
    torch.manual_seed(0)
    if options['task']=='causal-lm-inference':
        from transformers import AutoTokenizer,AutoModelForCausalLM
        text=source.read_text(encoding='utf-8')
        if not text.strip() or len(text)>8192: raise ValueError('Use a prompt of at most 8192 characters')
        tokenizer=AutoTokenizer.from_pretrained(str(root),**common)
        model=AutoModelForCausalLM.from_pretrained(str(root),**common).to('cuda').eval()
        batch=tokenizer(text,return_tensors='pt',truncation=True,max_length=2048)
        batch={k:v.to('cuda') for k,v in batch.items()}
        with torch.no_grad(): result=model.generate(**batch,max_new_tokens=options['max_new_tokens'],do_sample=False,pad_token_id=tokenizer.eos_token_id)
        value=tokenizer.decode(result[0,batch['input_ids'].shape[-1]:],skip_special_tokens=True)
        filename='generation.json'
    else:
        import numpy as np
        from transformers import WhisperProcessor,WhisperForConditionalGeneration
        with wave.open(str(source),'rb') as f:
            if f.getnchannels()!=1 or f.getsampwidth()!=2 or f.getframerate()!=16000 or not 0<f.getnframes()<=480000:
                raise ValueError('Use mono 16 kHz PCM16 WAV of at most 30 seconds')
            frames=f.readframes(f.getnframes())
        audio=np.frombuffer(frames,dtype='<i2').astype(np.float32)/32768.0
        processor=WhisperProcessor.from_pretrained(str(root),**common)
        model=WhisperForConditionalGeneration.from_pretrained(str(root),**common).to('cuda').eval()
        batch=processor(audio,sampling_rate=16000,return_tensors='pt')
        features=batch.input_features.to('cuda')
        with torch.no_grad(): result=model.generate(features,max_new_tokens=options['max_new_tokens'],do_sample=False,task='transcribe',**({'language':options['language']} if options.get('language') else {}))
        value=processor.batch_decode(result,skip_special_tokens=True)[0]
        filename='transcript.json'
    if not isinstance(value,str) or len(value)>65536: raise ValueError('Result exceeds bounds')
    with (out/filename).open('x',encoding='utf-8') as f:json.dump({'text':value},f,ensure_ascii=False)
    return {'task':options['task'],'model':ref['repo_id'],'revision':ref['revision'],'max_new_tokens':options['max_new_tokens'],'output_file':filename}
