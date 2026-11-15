// The ES library has no WebAssembly types and this package does not load the DOM library.
declare namespace WebAssembly {
  type Module = object;
  function compile(bytes: Uint8Array): Promise<Module>;
}
