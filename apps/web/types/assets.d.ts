// Build-time imports, configured in next.config.ts.
declare module '*?raw' {
  const content: string;
  export default content;
}
declare module '*?base64' {
  const base64: string;
  export default base64;
}
