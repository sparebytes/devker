require("@babel/register")({
  cwd: __dirname,
  rootMode: "root",
  babelrc: true,
  extensions: [".csj", ".es", ".es6", ".js", ".jsx", ".mjs", ".ts", ".tsx"],
});
require("./src/cli.js");
