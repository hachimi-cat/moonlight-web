import path from "node:path";
import { fileURLToPath } from "node:url";
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from "copy-webpack-plugin";

// In Node.js versions prior to native support for import.meta.dirname,
// derive __dirname from import.meta.url.
// (Node 20.11+ supports import.meta.dirname and import.meta.filename.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    // TODO: change based on env
    mode: "development",
    entry: {
        // TODO: also include i18n
        common: ["./web/styles/index.ts"],
        index: "./web/index.ts",
        stream: "./web/stream.ts",
        admin: "./web/admin.ts"
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: "ts-loader",
                exclude: /node_modules/,
            },
            // Tailwind for the React islands. Injected EAGERLY (plain
            // style-loader), unlike the lazy sheets below: the vanilla UI
            // toggles its themes by calling .use()/.unuse() on a lazy tag,
            // but utility classes have to be present the moment a component
            // renders. Must be matched before the general .css rule, and
            // that rule excludes .tw.css so the two don't both apply.
            {
                test: /\.tw\.css$/i,
                use: ['style-loader', 'css-loader', 'postcss-loader']
            },
            {
                test: /\.css$/i,
                exclude: /\.tw\.css$/i,
                use: [
                    {
                        loader: 'style-loader',
                        options: {
                            injectType: 'lazyStyleTag'
                        }
                    },
                    'css-loader'
                ]
            },
            {
                test: /\.(png|svg|jpg|jpeg|gif)$/i,
                type: 'asset/resource',
            },
            {
                test: /\.(wasm)$/i,
                type: 'asset/resource',
            },
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            filename: 'index.html',
            template: './web/index.html',
            chunks: ['index'],
            scriptLoading: 'blocking'
        }),
        new HtmlWebpackPlugin({
            filename: 'stream.html',
            template: './web/stream.html',
            chunks: ['stream'],
            scriptLoading: 'blocking'
        }),
        new HtmlWebpackPlugin({
            filename: 'admin.html',
            template: './web/admin.html',
            chunks: ['admin'],
            scriptLoading: 'blocking'
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: "./web/manifest.json",
                    to: "manifest.json"
                },
            ],
        }),
    ],
    resolve: {
        extensions: [".tsx", ".ts", ".js"]
    },
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, "dist"),
        clean: true
    },
    externals: {
        "./config.js": "window.__RUNTIME_CONFIG__",
        "../../libopenh264/decoder.js": "window.__OPENH264_DECODER__",
    }
};
