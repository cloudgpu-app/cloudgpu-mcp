import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('LoRA probes installed CUDA bf16 mask kernel and preserves unrelated failures',()=>{
 const result=spawnSync('python3',['-c',`import ast,pathlib,types
source=ast.parse(pathlib.Path('src/recipes/causal-lora.py').read_text());scope={}
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='training_dtype'],type_ignores=[]),'dtype','exec'),scope)
t=types.SimpleNamespace(float32='fp32',bfloat16='bf16',cuda=types.SimpleNamespace(is_bf16_supported=lambda:True),ones=lambda *a,**k:None,triu=lambda *a,**k:None)
assert scope['training_dtype'](t)=='bf16'
def unsupported(*a,**k):raise RuntimeError('triu_tril_cuda_template not implemented for BFloat16')
t.triu=unsupported
assert scope['training_dtype'](t)=='fp32'
def oom(*a,**k):raise RuntimeError('CUDA out of memory')
t.triu=oom
try:scope['training_dtype'](t)
except RuntimeError as e:assert str(e)=='CUDA out of memory'
else:raise AssertionError('unrelated CUDA errors must propagate')
`],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
