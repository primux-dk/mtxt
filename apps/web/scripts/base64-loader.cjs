// webpack loader for `?base64` imports: the file's bytes as a base64 string.
module.exports = function base64Loader(content) {
  return `export default ${JSON.stringify(content.toString('base64'))};`;
};
module.exports.raw = true;
