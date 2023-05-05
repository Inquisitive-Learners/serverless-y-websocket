import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
export declare const messageSync = 0;
export declare const messageQueryAwareness = 3;
export declare const messageAwareness = 1;
export declare const messageAuth = 2;
export declare class WebsocketProvider extends Observable<string> {
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
    wsUnsuccessfulReconnects: number;
    _synced: boolean;
    wsLastMessageReceived: number;
    ws: WebSocket | null;
    shouldConnect: boolean;
    _resyncInterval: any;
    _checkInterval: any;
    transformRead: {
        (data: any): Uint8Array;
    };
    transformWrite: {
        (data: any): any;
    };
    _updateHandler: {
        (update: Uint8Array, origin: any): void;
    };
    _bcSubscriber: {
        (data: ArrayBuffer, origin: any): void;
    };
    _awarenessUpdateHandler: {
        ({ added, updated, removed }: {
            added: any;
            updated: any;
            removed: any;
        }): void;
    };
    _unloadHandler: {
        (): void;
    };
    messageHandlers: {
        (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: WebsocketProvider, emitSynced: boolean, _messageType: number): void;
    }[];
    constructor(serverUrl: string, roomname: string, doc: Y.Doc, { connect, awareness, transformRead, transformWrite, params, resyncInterval, maxBackoffTime, disableBc }?: {
        connect?: boolean;
        transformRead?: {
            (data: any): Uint8Array;
        };
        transformWrite?: {
            (data: any): any;
        };
        awareness?: awarenessProtocol.Awareness;
        params?: any;
        resyncInterval?: number;
        maxBackoffTime?: number;
        disableBc?: boolean;
    });
    get synced(): boolean;
    set synced(state: boolean);
    destroy(): void;
    connectBc(): void;
    disconnectBc(): void;
    send(encoder: encoding.Encoder): void;
    disconnect(): void;
    connect(): void;
}
