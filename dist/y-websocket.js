"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebsocketProvider = exports.messageAuth = exports.messageAwareness = exports.messageQueryAwareness = exports.messageSync = void 0;
const math = __importStar(require("lib0/math"));
const url = __importStar(require("lib0/url"));
const bc = __importStar(require("lib0/broadcastchannel"));
const time = __importStar(require("lib0/time"));
const encoding = __importStar(require("lib0/encoding"));
const decoding = __importStar(require("lib0/decoding"));
const observable_1 = require("lib0/observable");
const authProtocol = __importStar(require("y-protocols/auth"));
const awarenessProtocol = __importStar(require("y-protocols/awareness"));
const syncProtocol = __importStar(require("y-protocols/sync"));
exports.messageSync = 0;
exports.messageQueryAwareness = 3;
exports.messageAwareness = 1;
exports.messageAuth = 2;
const messageReconnectTimeout = 30000;
const messageHandlers = [];
messageHandlers[exports.messageSync] = (encoder, decoder, provider, emitSynced, _messageType) => {
    encoding.writeVarUint(encoder, exports.messageSync);
    const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, provider.doc, provider);
    if (emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 &&
        !provider.synced) {
        provider.synced = true;
    }
};
messageHandlers[exports.messageQueryAwareness] = (encoder, _decoder, provider, _emitSynced, _messageType) => {
    encoding.writeVarUint(encoder, exports.messageAwareness);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(provider.awareness, Array.from(provider.awareness.getStates().keys())));
};
messageHandlers[exports.messageAwareness] = (_encoder, decoder, provider, _emitSynced, _messageType) => {
    awarenessProtocol.applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider);
};
messageHandlers[exports.messageAuth] = (_encoder, decoder, provider, _emitSynced, _messageType) => {
    authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) => permissionDeniedHandler(provider, reason));
};
class WebsocketProvider extends observable_1.Observable {
    constructor(serverUrl, roomname, doc, { connect = true, awareness = new awarenessProtocol.Awareness(doc), transformRead = defaultTransformRead, transformWrite = defaultTransformWrite, params = {}, resyncInterval = -1, maxBackoffTime = 2500, disableBc = false } = {}) {
        super();
        // ensure that url is always ends with /
        while (serverUrl[serverUrl.length - 1] === "/") {
            serverUrl = serverUrl.slice(0, serverUrl.length - 1);
        }
        const encodedParams = url.encodeQueryParams(params);
        this.maxBackoffTime = maxBackoffTime;
        this.bcChannel = `${serverUrl}/${roomname}`;
        this.url = serverUrl + "/" + roomname +
            (encodedParams.length === 0 ? "" : "?" + encodedParams);
        this.roomname = roomname;
        this.doc = doc;
        this.awareness = awareness;
        this.wsconnected = false;
        this.wsconnecting = false;
        this.bcconnected = false;
        this.transformRead = transformRead;
        this.transformWrite = transformWrite;
        this.disableBc = disableBc;
        this.wsUnsuccessfulReconnects = 0;
        this.messageHandlers = messageHandlers.slice();
        this._synced = false;
        this.ws = null;
        this.wsLastMessageReceived = 0;
        this.shouldConnect = connect;
        this._resyncInterval = 0;
        if (resyncInterval > 0) {
            this._resyncInterval = (setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    // resend sync step 1
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, exports.messageSync);
                    syncProtocol.writeSyncStep1(encoder, doc);
                    this.send(encoder);
                }
            }, resyncInterval));
        }
        this._bcSubscriber = (data, origin) => {
            if (origin !== this) {
                const encoder = readMessage(this, new Uint8Array(data), false);
                if (encoding.length(encoder) > 1) {
                    bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this);
                }
            }
        };
        this._updateHandler = (update, origin) => {
            if (origin !== this) {
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, exports.messageSync);
                syncProtocol.writeUpdate(encoder, update);
                broadcastMessage(this, encoder);
            }
        };
        this.doc.on("update", this._updateHandler);
        this._awarenessUpdateHandler = ({ added, updated, removed }) => {
            const changedClients = added.concat(updated).concat(removed);
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, exports.messageAwareness);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
            broadcastMessage(this, encoder);
        };
        this._unloadHandler = () => {
            awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], "window unload");
        };
        if (typeof window !== "undefined") {
            window.addEventListener("unload", this._unloadHandler);
        }
        else if (typeof process !== "undefined") {
            process.on("exit", this._unloadHandler);
        }
        awareness.on("update", this._awarenessUpdateHandler);
        this._checkInterval = (setInterval(() => {
            var _a;
            if (this.wsconnected &&
                messageReconnectTimeout <
                    time.getUnixTime() - this.wsLastMessageReceived) {
                // no message received in a long time - not even your own awareness
                // updates (which are updated every 15 seconds)
                (_a = this.ws) === null || _a === void 0 ? void 0 : _a.close();
            }
        }, messageReconnectTimeout / 10));
        if (connect) {
            this.connect();
        }
    }
    get synced() {
        return this._synced;
    }
    set synced(state) {
        if (this._synced !== state) {
            this._synced = state;
            this.emit("synced", [state]);
            this.emit("sync", [state]);
        }
    }
    destroy() {
        if (this._resyncInterval !== 0) {
            clearInterval(this._resyncInterval);
        }
        clearInterval(this._checkInterval);
        this.disconnect();
        if (typeof window !== "undefined") {
            window.removeEventListener("unload", this._unloadHandler);
        }
        else if (typeof process !== "undefined") {
            process.off("exit", this._unloadHandler);
        }
        this.awareness.off("update", this._awarenessUpdateHandler);
        this.doc.off("update", this._updateHandler);
        super.destroy();
    }
    connectBc() {
        if (this.disableBc) {
            return;
        }
        if (!this.bcconnected) {
            bc.subscribe(this.bcChannel, this._bcSubscriber);
            this.bcconnected = true;
        }
        // send sync step1 to bc
        // write sync step 1
        const encoderSync = encoding.createEncoder();
        encoding.writeVarUint(encoderSync, exports.messageSync);
        syncProtocol.writeSyncStep1(encoderSync, this.doc);
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
        // broadcast local state
        const encoderState = encoding.createEncoder();
        encoding.writeVarUint(encoderState, exports.messageSync);
        syncProtocol.writeSyncStep2(encoderState, this.doc);
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
        // write queryAwareness
        const encoderAwarenessQuery = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessQuery, exports.messageQueryAwareness);
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderAwarenessQuery), this);
        // broadcast local awareness state
        const encoderAwarenessState = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessState, exports.messageAwareness);
        encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID
        ]));
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderAwarenessState), this);
    }
    disconnectBc() {
        // broadcast message with local awareness state set to null (indicating disconnect)
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, exports.messageAwareness);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID
        ], new Map()));
        broadcastMessage(this, encoder);
        if (this.bcconnected) {
            bc.unsubscribe(this.bcChannel, this._bcSubscriber);
            this.bcconnected = false;
        }
    }
    send(encoder) {
        if (this.ws) {
            const msg = encoding.toUint8Array(encoder);
            this.ws.send(this.transformWrite(msg));
        }
    }
    disconnect() {
        this.shouldConnect = false;
        this.disconnectBc();
        if (this.ws !== null) {
            this.ws.close();
        }
    }
    connect() {
        this.shouldConnect = true;
        if (!this.wsconnected && this.ws === null) {
            setupWS(this);
            this.connectBc();
        }
    }
}
exports.WebsocketProvider = WebsocketProvider;
const broadcastMessage = (provider, encoder) => {
    const ws = provider.ws;
    if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
        provider.send(encoder);
    }
    if (provider.bcconnected) {
        bc.publish(provider.bcChannel, encoding.toUint8Array(encoder));
    }
};
const permissionDeniedHandler = (provider, reason) => console.warn(`Permission denied to access ${provider.url}.\n${reason}`);
const readMessage = (provider, buf, emitSynced) => {
    const decoder = decoding.createDecoder(buf);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    const messageHandler = provider.messageHandlers[messageType];
    if (messageHandler) {
        messageHandler(encoder, decoder, provider, emitSynced, messageType);
    }
    else {
        console.error("Unable to compute message");
    }
    return encoder;
};
const setupWS = (provider) => {
    if (provider.shouldConnect && provider.ws === null) {
        const websocket = new WebSocket(provider.url);
        websocket.binaryType = "arraybuffer";
        provider.ws = websocket;
        provider.wsconnecting = true;
        provider.wsconnected = false;
        provider.synced = false;
        websocket.onmessage = (event) => {
            provider.wsLastMessageReceived = time.getUnixTime();
            const encoder = readMessage(provider, provider.transformRead(event.data), true);
            if (encoding.length(encoder) > 1) {
                provider.send(encoder);
            }
        };
        websocket.onerror = (event) => {
            provider.emit("connection-error", [event, provider]);
        };
        websocket.onclose = (event) => {
            provider.emit("connection-close", [event, provider]);
            provider.ws = null;
            provider.wsconnecting = false;
            if (provider.wsconnected) {
                provider.wsconnected = false;
                provider.synced = false;
                // update awareness (all users except local left)
                awarenessProtocol.removeAwarenessStates(provider.awareness, Array.from(provider.awareness.getStates().keys()).filter((client) => client !== provider.doc.clientID), provider);
                provider.emit("status", [{
                        status: "disconnected"
                    }]);
            }
            else {
                provider.wsUnsuccessfulReconnects++;
            }
            // Start with no reconnect timeout and increase timeout by
            // using exponential backoff starting with 100ms
            setTimeout(setupWS, math.min(math.pow(2, provider.wsUnsuccessfulReconnects) * 100, provider.maxBackoffTime), provider);
        };
        websocket.onopen = () => {
            provider.wsLastMessageReceived = time.getUnixTime();
            provider.wsconnecting = false;
            provider.wsconnected = true;
            provider.wsUnsuccessfulReconnects = 0;
            provider.emit("status", [{
                    status: "connected"
                }]);
            // always send sync step 1 when connected
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, exports.messageSync);
            syncProtocol.writeSyncStep1(encoder, provider.doc);
            provider.send(encoder);
            // broadcast local awareness state
            if (provider.awareness.getLocalState() !== null) {
                const encoderAwarenessState = encoding.createEncoder();
                encoding.writeVarUint(encoderAwarenessState, exports.messageAwareness);
                encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
                    provider.doc.clientID
                ]));
                provider.send(encoderAwarenessState);
            }
        };
        provider.emit("status", [{
                status: "connecting"
            }]);
    }
};
const defaultTransformRead = (data) => new Uint8Array(data);
const defaultTransformWrite = (data) => data;
