module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "10.20",
        },
      },
    ],
  ],
  plugins: [
    //
    ["@babel/plugin-proposal-decorators", { legacy: true }],
    ["@babel/plugin-proposal-class-properties", { loose: true }],
    ["babel-plugin-macros"],
    ["@babel/plugin-transform-runtime"],
  ],
  sourceMaps: true,
};
