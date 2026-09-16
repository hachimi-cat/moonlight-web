/*
 * Local visual harness only. Never referenced by `npm run build` and never
 * shipped — it exists so the React islands can be rendered and screenshotted
 * without a live stream session.
 *
 *   npx webpack --config webpack.harness.js
 *   python3 -m http.server -d dist-harness
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import HtmlWebpackPlugin from "html-webpack-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
    mode: "development",
    entry: { harness: "./web/ui/__harness__/index.tsx" },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: "ts-loader",
                exclude: /node_modules/,
            },
            {
                test: /\.tw\.css$/i,
                use: ["style-loader", "css-loader", "postcss-loader"],
            },
            {
                test: /\.css$/i,
                exclude: /\.tw\.css$/i,
                use: [
                    { loader: "style-loader", options: { injectType: "lazyStyleTag" } },
                    "css-loader",
                ],
            },
            { test: /\.(png|svg|jpg|jpeg|gif)$/i, type: "asset/resource" },
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            filename: "index.html",
            template: "./web/ui/__harness__/index.html",
            chunks: ["harness"],
            scriptLoading: "blocking",
        }),
    ],
    resolve: { extensions: [".tsx", ".ts", ".js"] },
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, "dist-harness"),
        clean: true,
    },
};
