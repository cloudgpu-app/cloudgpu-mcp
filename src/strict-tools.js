import {z} from "zod";

/** JSON tool contracts already advertise no extra fields; enforce that instead of stripping constraints. */
export function useStrictToolInputs(server){
  const register=server.registerTool.bind(server);
  server.registerTool=(name,config,...rest)=>{
    if(config.inputSchema){
      const schema=typeof config.inputSchema.safeParse==="function"?config.inputSchema:z.object(config.inputSchema);
      config={...config,inputSchema:typeof schema.strict==="function"?schema.strict():schema};
    }
    return register(name,config,...rest);
  };
}
