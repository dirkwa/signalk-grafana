const path = require("path");
const { ModuleFederationPlugin } = require("webpack").container;
const packageJson = require("./package.json");

// WHY ESM container: the server injects <script type="module"> for type-module plugins and the Admin UI dynamic-imports real get/init exports — a classic `var` remote fails with a misleading "webapp is not installed" error.
module.exports = {
  entry: "./src/configpanel/index",
  mode: "production",
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, "public"),
    module: true,
    // WHY clean: stale chunks from the previous module format would otherwise ship in the npm pack forever.
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        loader: "babel-loader",
        exclude: /node_modules/,
        options: { presets: ["@babel/preset-react"] },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx"],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, "_"),
      library: { type: "module" },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
