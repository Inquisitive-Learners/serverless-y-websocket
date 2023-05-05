import * as math from "lib0/math";
import * as Y from "yjs";
import * as url from "lib0/url";
import * as bc from "lib0/broadcastchannel";
import * as time from "lib0/time";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;
const messageReconnectTimeout = 30000;

const messageHandlers: {(encoder: encoding.Encoder, decoder:decoding.Decoder, provider:WebsocketProvider, emitSynced:boolean,_messageType:number):void}[]  = [];
messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageSync)
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    provider.doc,
    provider
  )
  if (
    emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 &&
    !provider.synced
  ) {
    provider.synced = true
  }
}

messageHandlers[messageQueryAwareness] = (
  encoder,
  _decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(
      provider.awareness,
      Array.from(provider.awareness.getStates().keys())
    )
  )
}
messageHandlers[messageAwareness] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  awarenessProtocol.applyAwarenessUpdate(
    provider.awareness,
    decoding.readVarUint8Array(decoder),
    provider
  )
}
messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  authProtocol.readAuthMessage(
    decoder,
    provider.doc,
    (_ydoc, reason) => permissionDeniedHandler(provider, reason)
  )
}


export class WebsocketProvider extends Observable<string> {

  maxBackoffTime: number;
  bcChannel: string;
  url: string;
  roomname: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  wsconnected: boolean;
  bcconnected: boolean;
  wsconnecting: boolean;
  disableBc: boolean;
  wsUnsuccessfulReconnects:number;
  _synced: boolean;
  wsLastMessageReceived: number;
  ws: WebSocket | null;
  shouldConnect: boolean;
  _resyncInterval: any;
  _checkInterval: any;
  transformRead: {(data:any):Uint8Array};
  transformWrite: {(data:any):any};
  _updateHandler: {(update:Uint8Array, origin:any): void};
  _bcSubscriber: {(data:ArrayBuffer, origin:any): void};
  _awarenessUpdateHandler: {({ added, updated, removed}:{added:any, updated:any, removed:any}): void};
  _unloadHandler: {():void};
  messageHandlers: {(encoder: encoding.Encoder, decoder:decoding.Decoder, provider:WebsocketProvider, emitSynced:boolean,_messageType:number):void}[];
  constructor (serverUrl: string, roomname: string, doc: Y.Doc, {
    connect = true,
    awareness = new awarenessProtocol.Awareness(doc),
    transformRead = defaultTransformRead,
    transformWrite = defaultTransformWrite,
    params = {},
    resyncInterval = -1,
    maxBackoffTime = 2500,
    disableBc = false
  }: {connect?: boolean, transformRead?:{(data:any):Uint8Array},transformWrite?:{(data:any):any},awareness?:awarenessProtocol.Awareness,params?: any, resyncInterval?: number,maxBackoffTime?:number,disableBc?:boolean} = {}) {
    super()
    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1)
    }
    const encodedParams = url.encodeQueryParams(params)
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
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.writeSyncStep1(encoder, doc)
          this.send(encoder);
        }
      }, resyncInterval))
    }

    this._bcSubscriber = (data:ArrayBuffer, origin:any) => {
      if (origin !== this) {
        const encoder = readMessage(this, new Uint8Array(data), false)
        if (encoding.length(encoder) > 1) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this)
        }
      }
    }

    this._updateHandler = (update:Uint8Array, origin:any) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeUpdate(encoder, update)
        broadcastMessage(this, encoder)
      }
    }
    this.doc.on("update", this._updateHandler)
   
    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      const changedClients = added.concat(updated).concat(removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      )
      broadcastMessage(this, encoder)
    }
    this._unloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        "window unload"
      )
    }
    if (typeof window !== "undefined") {
      window.addEventListener("unload", this._unloadHandler)
    } else if (typeof process !== "undefined") {
      process.on("exit", this._unloadHandler)
    }
    awareness.on("update", this._awarenessUpdateHandler)
    this._checkInterval =  (setInterval(() => {
      if (
        this.wsconnected &&
        messageReconnectTimeout <
          time.getUnixTime() - this.wsLastMessageReceived
      ) {
        // no message received in a long time - not even your own awareness
        // updates (which are updated every 15 seconds)
        this.ws?.close()
      }
    }, messageReconnectTimeout / 10))
    if (connect) {
      this.connect()
    }
  }

  get synced () {
    return this._synced
  }

  set synced (state) {
    if (this._synced !== state) {
      this._synced = state
      this.emit("synced", [state])
      this.emit("sync", [state])
    }
  }


  destroy () {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval)
    }
    clearInterval(this._checkInterval)
    this.disconnect()
    if (typeof window !== "undefined") {
      window.removeEventListener("unload", this._unloadHandler)
    } else if (typeof process !== "undefined") {
      process.off("exit", this._unloadHandler)
    }
    this.awareness.off("update", this._awarenessUpdateHandler)
    this.doc.off("update", this._updateHandler)
    super.destroy()
  }

  connectBc () {
    if (this.disableBc) {
      return
    }
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = true
    }
    // send sync step1 to bc
    // write sync step 1
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, messageSync)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this)
    // broadcast local state
    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, messageSync)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this)
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    )
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ])
    )
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    )
  }

  disconnectBc () {
    // broadcast message with local awareness state set to null (indicating disconnect)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ], new Map())
    )
    broadcastMessage(this, encoder)
    if (this.bcconnected) {
      bc.unsubscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = false
    }
  }
  send (encoder: encoding.Encoder) {
    if (this.ws) {
      const msg = encoding.toUint8Array(encoder)
      this.ws.send(this.transformWrite(msg))
    }
  }
  disconnect () {
    this.shouldConnect = false
    this.disconnectBc()
    if (this.ws !== null) {
      this.ws.close()
    }
  }

  connect () {
    this.shouldConnect = true
    if (!this.wsconnected && this.ws === null) {
      setupWS(this)
      this.connectBc()
    }
  }
}


const broadcastMessage = (provider:WebsocketProvider, encoder:encoding.Encoder): void => {
  const ws = provider.ws
  if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
    provider.send(encoder)
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, encoding.toUint8Array(encoder))
  }
}

const permissionDeniedHandler = (provider:WebsocketProvider, reason: string) =>
  console.warn(`Permission denied to access ${provider.url}.\n${reason}`)

  const readMessage = (provider:WebsocketProvider, buf:Uint8Array, emitSynced:boolean): encoding.Encoder => {
    const decoder = decoding.createDecoder(buf)
    const encoder = encoding.createEncoder()
    const messageType = decoding.readVarUint(decoder)
    const messageHandler = provider.messageHandlers[messageType]
    if (messageHandler) {
      messageHandler(encoder, decoder, provider, emitSynced, messageType)
    } else {
      console.error("Unable to compute message")
    }
    return encoder
  }
  
  const setupWS = (provider:WebsocketProvider) => {
    if (provider.shouldConnect && provider.ws === null) {
      const websocket = new WebSocket(provider.url)
      websocket.binaryType = "arraybuffer"
      provider.ws = websocket
      provider.wsconnecting = true
      provider.wsconnected = false
      provider.synced = false
  
      websocket.onmessage = (event:any) => {
        provider.wsLastMessageReceived = time.getUnixTime()

        const encoder = readMessage(provider, provider.transformRead(event.data), true)
        if (encoding.length(encoder) > 1) {
          provider.send(encoder)
        }
      }
      websocket.onerror = (event) => {
        provider.emit("connection-error", [event, provider])
      }
      websocket.onclose = (event) => {
        provider.emit("connection-close", [event, provider])
        provider.ws = null
        provider.wsconnecting = false
        if (provider.wsconnected) {
          provider.wsconnected = false
          provider.synced = false
          // update awareness (all users except local left)
          awarenessProtocol.removeAwarenessStates(
            provider.awareness,
            Array.from(provider.awareness.getStates().keys()).filter((client) =>
              client !== provider.doc.clientID
            ),
            provider
          )
          provider.emit("status", [{
            status: "disconnected"
          }])
        } else {
          provider.wsUnsuccessfulReconnects++
        }
        // Start with no reconnect timeout and increase timeout by
        // using exponential backoff starting with 100ms
        setTimeout(
          setupWS,
          math.min(
            math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
            provider.maxBackoffTime
          ),
          provider
        )
      }
      websocket.onopen = () => {
        provider.wsLastMessageReceived = time.getUnixTime()
        provider.wsconnecting = false
        provider.wsconnected = true
        provider.wsUnsuccessfulReconnects = 0
        provider.emit("status", [{
          status: "connected"
        }])
        // always send sync step 1 when connected
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeSyncStep1(encoder, provider.doc)
        provider.send(encoder)
        // broadcast local awareness state
        if (provider.awareness.getLocalState() !== null) {
          const encoderAwarenessState = encoding.createEncoder()
          encoding.writeVarUint(encoderAwarenessState, messageAwareness)
          encoding.writeVarUint8Array(
            encoderAwarenessState,
            awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
              provider.doc.clientID
            ])
          )
          provider.send(encoderAwarenessState)
        }
      }
      provider.emit("status", [{
        status: "connecting"
      }])
    }
  }

const defaultTransformRead = (data: any): Uint8Array => new Uint8Array(data)
const defaultTransformWrite = (data: any) => data