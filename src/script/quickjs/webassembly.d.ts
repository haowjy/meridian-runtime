// The ES library has no WebAssembly types and this package does not load the DOM library.
declare namespace WebAssembly {
  type Module = object;
  class Memory {
    constructor(descriptor: { initial: number; maximum?: number });
    readonly buffer: { readonly byteLength: number };
  }
  class RuntimeError extends Error {}
  function compile(bytes: Uint8Array): Promise<Module>;
}
