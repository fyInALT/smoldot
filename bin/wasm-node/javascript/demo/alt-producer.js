import * as smoldot from "../dist/index.js";
import { default as websocket } from "websocket";
import * as http from "node:http";
import * as process from "node:process";
import * as fs from "node:fs";

// Adjust these chain specs for the chain you want to connect to.
const producer_genesis = fs.readFileSync("./producer.json", "utf8");

const client = smoldot.start({
    maxLogLevel: 3, // Can be increased for more verbosity
    forbidTcp: false,
    forbidWs: false,
    forbidNonLocalWs: false,
    forbidWss: false,
    cpuRateLimit: 0.5,
    logCallback: (level, target, message) => {
        // As incredible as it seems, there is currently no better way to print the current time
        // formatted in a certain way.
        const now = new Date();
        const hours = ("0" + now.getHours()).slice(-2);
        const minutes = ("0" + now.getMinutes()).slice(-2);
        const seconds = ("0" + now.getSeconds()).slice(-2);
        const milliseconds = ("00" + now.getMilliseconds()).slice(-3);
        console.log(
            "[%s:%s:%s.%s] [%s] %s",
            hours,
            minutes,
            seconds,
            milliseconds,
            target,
            message
        );
    },
});

// Pre-load smoldot with the relay chain spec.
// We call `addChain` again with the same chain spec again every time a new WebSocket connection
// is established, but smoldot will de-duplicate them and only connect to the chain once.
// By calling it now, we let smoldot start syncing that chain in the background even before a
// WebSocket connection has been established.
client.addChain({ chainSpec: producer_genesis }).catch((error) => {
    console.error("Error while adding chain: " + error);
    process.exit(1);
});

// Start the WebSocket server listening on port 9944.
let server = http.createServer(function (request, response) {
    response.writeHead(404);
    response.end();
});

server.listen(9944, function () {});

let wsServer = new websocket.server({
    httpServer: server,
    autoAcceptConnections: false,
});

wsServer.on("request", function (request) {
    // Received a new incoming WebSocket connection.
    let chain = (async () => {
        return {
            relay: await client.addChain({
                chainSpec: producer_genesis,
                jsonRpcCallback: (resp) => {
                    connection.sendUTF(resp);
                },
            }),
        };
    })();

    const connection = request.accept(
        request.requestedProtocols[0],
        request.origin
    );
    console.log(
        "(demo) New JSON-RPC client connected: " + request.remoteAddress + "."
    );

    chain.catch((error) => {
        console.error("(demo) Error while adding chain: " + error);
        connection.close(400);
    });

    // Receiving a message from the connection. This is a JSON-RPC request.
    connection.on("message", function (message) {
        if (message.type === "utf8") {
            chain
                .then((chain) => {
                    if (chain.para) chain.para.sendJsonRpc(message.utf8Data);
                    else chain.relay.sendJsonRpc(message.utf8Data);
                })
                .catch((error) => {
                    console.error(
                        "(demo) Error during JSON-RPC request: " + error
                    );
                    process.exit(1);
                });
        } else {
            connection.close(400);
        }
    });

    // When the connection closes, remove the chains that have been added.
    connection.on("close", function (reasonCode, description) {
        console.log(
            "(demo) JSON-RPC client " +
                connection.remoteAddress +
                " disconnected."
        );
        chain
            .then((chain) => {
                chain.relay.remove();
                if (chain.para) chain.para.remove();
            })
            .catch(() => {});
    });
});
