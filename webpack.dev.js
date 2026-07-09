const { merge } = require('webpack-merge');

const common = require('./webpack.common');

function getDevServerPort() {
    const rawPort = process.env.npm_config_port || process.env.PORT;

    if (!rawPort) {
        return undefined;
    }

    const port = Number(rawPort);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid dev server port: ${rawPort}`);
    }

    return port;
}

const devServerPort = getDevServerPort();

module.exports = merge(common, {
    // In order for live reload to work we must use "web" as the target not "browserslist"
    target: process.env.WEBPACK_SERVE ? 'web' : 'browserslist',
    mode: 'development',
    devtool: 'eval-cheap-module-source-map',
    module: {
        rules: [
            {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /node_modules/,
                enforce: 'pre',
                use: ['source-map-loader']
            }
        ]
    },
    devServer: {
        compress: true,
        ...(devServerPort ? { port: devServerPort } : {}),
        client: {
            overlay: {
                errors: true,
                warnings: false,
                runtimeErrors: false
            }
        }
    }
});
