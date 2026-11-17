import importlib.metadata as m,pathlib,torch
assert torch.cuda.is_available(),'CUDA image required; not installing or replacing torch'
p=pathlib.Path.home()/'cloudgpu-test-torch-constraints.txt';items=[]
for name in ['torch','torchvision','torchaudio']:
 try:items.append(name+'=='+m.version(name))
 except m.PackageNotFoundError:pass
p.write_text(chr(10).join(items)+chr(10))
