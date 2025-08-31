import { Process } from "./process";
import {
    HostConnection,
    HostSession,
    AgentSession,
    AgentSessionId,
    VariantDict,
    Variant,
    MessageBus,
} from "./protocol";
import {
    Session,
    SessionDetachReason,
} from "./session";

import { parseMessages, serializeMessage, MessageType } from 'd-bus-message-protocol';
import { parseTypes } from 'd-bus-type-system';
import type { SignalMessage } from 'd-bus-message-protocol';


class WebSocketWrapper {
    public ws: WebSocket;
    private listeners = new Map<string, Function[]>();

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.setupWebSocketListeners();
    }

    private setupWebSocketListeners() {
        this.ws.addEventListener('close', (event) => {
            this.emit('close', event);
        });
        
        this.ws.addEventListener('error', (event) => {
            this.emit('error', event);
        });
        
        this.ws.addEventListener('message', async (event) => {
            let messageData: ArrayBuffer;
            if (event.data instanceof Blob) {
                messageData = await event.data.arrayBuffer();
            } else {
                messageData = event.data;
            }
            this.emit('message', messageData);
        });
    }

    private emit(eventName: string, data: any) {
        const eventListeners = this.listeners.get(eventName) || [];
        eventListeners.forEach(listener => listener(data));
    }

    on(event: string, listener: Function) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(listener);
    }

    once(event: string, listener: Function) {
        const onceWrapper = (data: any) => {
            listener(data);
            this.off(event, onceWrapper);
        };
        this.on(event, onceWrapper);
    }

    off(event: string, listener: Function) {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            const index = eventListeners.indexOf(listener);
            if (index > -1) {
                eventListeners.splice(index, 1);
            }
        }
    }

    send(data: ArrayBuffer) {
        this.ws.send(data);
    }
}


class BrowserDBusClient implements MessageBus {
    private ws: WebSocketWrapper;
    private serialCounter = 1;
    private pendingCalls = new Map<number, { resolve: Function, reject: Function }>();
    private signalHandlers = new Map<string, Function[]>();

    constructor(ws: WebSocketWrapper) {
        this.ws = ws;
        this.ws.on('message', this.handleMessage.bind(this));
    }

    addSignalListener(objectPath: string, interfaceName: string, memberName: string, handler: Function) {
        const key = `${objectPath}:${interfaceName}:${memberName}`;
        if (!this.signalHandlers.has(key)) {
            this.signalHandlers.set(key, []);
        }
        this.signalHandlers.get(key)!.push(handler);
    }

    removeSignalListener(objectPath: string, interfaceName: string, memberName: string, handler: Function) {
        const key = `${objectPath}:${interfaceName}:${memberName}`;
        const handlers = this.signalHandlers.get(key);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    private async handleMessage(messageData: ArrayBuffer) {
        try {
            const messages = parseMessages(messageData);
            for (const msg of messages) {
                if (msg.messageType === MessageType.MethodReturn) {
                    const pending = this.pendingCalls.get(msg.serial);
                    if (pending) {
                        this.pendingCalls.delete(msg.serial);
                        pending.resolve(msg.args);
                    }
                } else if (msg.messageType === MessageType.Error) {
                    const pending = this.pendingCalls.get(msg.serial);
                    if (pending) {
                        this.pendingCalls.delete(msg.serial);
                        const errorMsg = msg as any;
                        pending.reject(new Error(`D-Bus Error: ${errorMsg.errorName} - ${errorMsg.args?.[0] || 'Unknown error'}`));
                    }
                } else if (msg.messageType === MessageType.Signal) {
                    const signalMsg = msg as SignalMessage;
                    console.log('D-Bus Signal received:', {
                        objectPath: signalMsg.objectPath,
                        interfaceName: signalMsg.interfaceName,
                        memberName: signalMsg.memberName,
                        args: signalMsg.args
                    });
                    const key = `${signalMsg.objectPath}:${signalMsg.interfaceName}:${signalMsg.memberName}`;
                    const handlers = this.signalHandlers.get(key);
                    console.log(`Looking for handlers with key: ${key}, found: ${handlers?.length || 0}`);
                    if (handlers) {
                        handlers.forEach(handler => {
                            try {
                                console.log('Calling signal handler with args:', signalMsg.args);
                                handler(signalMsg.args);
                            } catch (error) {
                                console.error('Error in signal handler:', error);
                            }
                        });
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing D-Bus message:', error);
        }
    }

    async callMethod(destination: string, objectPath: string, interfaceName: string, memberName: string, args?: any[]): Promise<any> {
        const serial = this.serialCounter++;
        
        const message: any = {
            messageType: MessageType.MethodCall,
            serial,
            noReplyExpected: false,
            noAutoStart: false,
            allowInteractiveAuthorization: false,
            destination,
            objectPath,
            interfaceName,
            memberName
        };

        if (memberName === "EnumerateProcesses") {
            const types = parseTypes("a{sv}");
            message.types = types;
            message.args = [[]];
        } else if (memberName === "Attach") {
            const types = parseTypes("ua{sv}");
            message.types = types;
            if (args && args.length >= 2) {
                const pid = args[0];
                const variantDict = args[1];
                const convertedOptions: any[] = [];
                for (const [key, variant] of Object.entries(variantDict)) {
                    const v = variant as Variant;
                    convertedOptions.push([key, [v.signature, v.value]]);
                }
                message.args = [pid, convertedOptions];
            } else {
                message.args = args;
            }
        } else if (memberName === "CreateScript") {
            const types = parseTypes("sa{sv}");
            message.types = types;
            if (args && args.length >= 2) {
                const source = args[0];
                const variantDict = args[1];
                const convertedOptions: any[] = [];
                for (const [key, variant] of Object.entries(variantDict)) {
                    const v = variant as Variant;
                    convertedOptions.push([key, [v.signature, v.value]]);
                }
                message.args = [source, convertedOptions];
            } else {
                message.args = args;
            }
        } else if (memberName === "LoadScript") {
            const types = parseTypes("((u))");
            message.types = types;
            console.log('LoadScript called with args:', args);
            if (args && args.length >= 1) {
                const scriptIdTuple = args[0] as [number];
                console.log('LoadScript scriptIdTuple:', scriptIdTuple);
                const nestedStruct = [scriptIdTuple];
                console.log('LoadScript final message.args:', nestedStruct);
                console.log('LoadScript final message.args structure:', JSON.stringify(nestedStruct));
                message.args = nestedStruct;
            }
        } else if (memberName === "DestroyScript") {
            const types = parseTypes("((u))");
            message.types = types;
            if (args && args.length >= 1) {
                const scriptIdTuple = args[0] as [number];
                message.args = [scriptIdTuple];
            }
        } else if (memberName === "PostMessages") {
            const types = parseTypes("aau");
            message.types = types;
            message.args = args;
        } else if (memberName === "Resume") {
            const types = parseTypes("u");
            message.types = types;
            message.args = args;
        } else if (memberName === "Close") {
            const types = parseTypes("");
            message.types = types;
            message.args = args || [];
        } else if (args && args.length > 0) {
            message.args = args;
        }

        const buffer = serializeMessage(message);
        this.ws.send(buffer);

        return new Promise((resolve, reject) => {
            this.pendingCalls.set(serial, { resolve, reject });
            
           
            setTimeout(() => {
                if (this.pendingCalls.has(serial)) {
                    this.pendingCalls.delete(serial);
                    reject(new Error('D-Bus call timeout'));
                }
            }, 30000);
        });
    }
}


class BrowserHostSession implements HostSession {
    constructor(private bus: MessageBus) {}

    async enumerateProcesses(options: VariantDict): Promise<Array<[number, string, VariantDict]>> {
        const result = await this.bus.callMethod(
            "re.frida.HostSession17",
            "/re/frida/HostSession",
            "re.frida.HostSession17",
            "EnumerateProcesses"
        );
        return result[0];
    }

    async attach(pid: number, options: VariantDict): Promise<AgentSessionId> {
        const result = await this.bus.callMethod(
            "re.frida.HostSession17",
            "/re/frida/HostSession",
            "re.frida.HostSession17",
            "Attach",
            [pid, options]
        );
        return result[0];
    }

    async reattach(id: AgentSessionId): Promise<void> {
        await this.bus.callMethod(
            "re.frida.HostSession17",
            "/re/frida/HostSession",
            "re.frida.HostSession17",
            "Reattach",
            [id]
        );
    }

    async querySystemParameters(): Promise<VariantDict> {
        const result = await this.bus.callMethod(
            "re.frida.HostSession17",
            "/re/frida/HostSession",
            "re.frida.HostSession17",
            "QuerySystemParameters"
        );
        return result[0];
    }
}


class BrowserAgentSession implements AgentSession {
    constructor(private bus: MessageBus, private sessionId: string) {}

    async close(): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "Close"
        );
    }

    async resume(rxBatchId: number): Promise<number> {
        const result = await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "Resume",
            [rxBatchId]
        );
        return result[0];
    }

    async createScript(source: string, options: VariantDict): Promise<[number]> {
        const result = await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "CreateScript",
            [source, options]
        );
        return result[0];
    }

    async destroyScript(scriptId: [number]): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "DestroyScript",
            [scriptId]
        );
    }

    async loadScript(scriptId: [number]): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "LoadScript",
            [scriptId]
        );
    }

    async postMessages(messages: any[], batchId: number): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "PostMessages",
            [messages, batchId]
        );
    }

    async offerPeerConnection(offerSdp: string, options: VariantDict): Promise<string> {
        const result = await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "OfferPeerConnection",
            [offerSdp, options]
        );
        return result[0];
    }

    async addCandidates(candidateSdps: string[]): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "AddCandidates",
            [candidateSdps]
        );
    }

    async notifyCandidateGatheringDone(): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "NotifyCandidateGatheringDone"
        );
    }

    async beginMigration(): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "BeginMigration"
        );
    }

    async commitMigration(): Promise<void> {
        await this.bus.callMethod(
            "re.frida.AgentSession17",
            `/re/frida/AgentSession/${this.sessionId}`,
            "re.frida.AgentSession17",
            "CommitMigration"
        );
    }
}

export class Client {
    private readonly _serverUrl: string;
    private readonly _token: string | null = null;

    private _hostConnectionRequest: Promise<HostConnection> | null = null;

    private readonly _sessions = new Map<string, Session>();

    constructor(host: string, options: ClientOptions = {}) {
        const { tls = "auto" } = options;
        let scheme: string = 'ws'
        // switch (tls) {
        //     case "auto":
        //         scheme = (typeof location !== "undefined" && location.protocol === "https:") ? "wss" : "ws";
        //         break;
        //     case "enabled":
        //         scheme = "wss";
        //         break;
        //     case "disabled":
        //         scheme = "ws";
        //         break;
        // }
        this._serverUrl = `${scheme}://${host}/ws`;

        if (options.token !== undefined) {
            this._token = options.token;
        }
    }

    async enumerateProcesses(options: ProcessQueryOptions = {}): Promise<Process[]> {
        const connection = await this._getHostConnection();

        const rawOptions: VariantDict = {};
        const { pids, scope } = options;
        if (pids !== undefined) {
            rawOptions.pids = new Variant("au", pids);
        }
        if (scope !== undefined) {
            rawOptions.scope = new Variant("s", scope);
        }

        const rawProcesses = await connection.session.enumerateProcesses(rawOptions);

        return rawProcesses.map(([pid, name, parameters]) => {
            return { pid, name, parameters };
        });
    }

    async attach(pid: number, options: SessionOptions = {}): Promise<Session> {
        const connection = await this._getHostConnection();

        const rawOptions: VariantDict = {};
        const { realm, persistTimeout } = options;
        if (realm !== undefined) {
            rawOptions.realm = new Variant("s", realm);
        }
        if (persistTimeout !== undefined) {
            rawOptions["persist-timeout"] = new Variant("u", persistTimeout);
        }

        const sessionId = await connection.session.attach(pid, rawOptions);

        const agentSession = new BrowserAgentSession(connection.bus, sessionId[0]);

        const session = new Session(this, agentSession, pid, sessionId[0], persistTimeout ?? 0, connection);
        this._sessions.set(session.id, session);
        
        const dbusClient = connection.bus as any;
        if (dbusClient.addSignalListener) {
            const signalHandler = (args: any[]) => {
                console.log('Agent session signal handler called with args:', args);
                if (args && args.length >= 2) {
                    const [messages, batchId] = args;
                    console.log('Processing incoming messages:', { messages, batchId });
                    session._handleIncomingMessages(messages, batchId);
                } else {
                    console.log('Signal args format unexpected:', args);
                }
            };
            const signalPath = `/re/frida/AgentSession/${sessionId[0]}`;
            console.log('Registering D-Bus signal listener:', {
                objectPath: signalPath,
                interfaceName: "re.frida.AgentSession17",
                memberName: "Message"
            });
            dbusClient.addSignalListener(
                signalPath,
                "re.frida.AgentSession17",
                "Message",
                signalHandler
            );
        }
        
        session._events.once("destroyed", () => {
            this._sessions.delete(session.id);
        });

        return session;
    }

    async querySystemParameters(): Promise<any> {
        const connection = await this._getHostConnection();
        const result = await connection.session.querySystemParameters();
        
        const parsed: any = {};
        if (result && Array.isArray(result)) {
            for (const [key, value] of result) {
                if (Array.isArray(value) && value.length >= 2) {
                    parsed[key] = this._parseVariantValue(value[1]);
                }
            }
        }
        return parsed;
    }

    private _parseVariantValue(value: any): any {
        if (Array.isArray(value)) {
            if (value.length >= 2 && typeof value[0] === 'object' && value[0].typeCode) {
                const typeInfo = value[0];
                const data = value[1];
                
                if (typeInfo.typeCode === 's') {
                    return data;
                } else if (typeInfo.typeCode === 'a' && Array.isArray(data)) {
                    const result: any = {};
                    for (const item of data) {
                        if (Array.isArray(item) && item.length >= 2) {
                            const itemKey = item[0];
                            const itemValue = item[1];
                            result[itemKey] = this._parseVariantValue(itemValue);
                        }
                    }
                    return result;
                }
                return data;
            } else if (Array.isArray(value)) {
                const result: any = {};
                for (const item of value) {
                    if (Array.isArray(item) && item.length >= 2) {
                        const itemKey = item[0];
                        const itemValue = item[1];
                        result[itemKey] = this._parseVariantValue(itemValue);
                    }
                }
                return result;
            }
        }
        return value;
    }

    async _getHostConnection(): Promise<HostConnection> {
        if (this._hostConnectionRequest === null) {
            this._hostConnectionRequest = this._doGetHostConnection();
        }
        return this._hostConnectionRequest;
    }

    private async _doGetHostConnection(): Promise<HostConnection> {
        const ws = new WebSocketWrapper(this._serverUrl);
        
        return new Promise((resolve, reject) => {
            ws.once('error', reject);
            
            ws.ws.addEventListener('open', async () => {
                ws.once("close", () => {
                    this._hostConnectionRequest = null;

                    for (const session of this._sessions.values()) {
                        session._onDetached(SessionDetachReason.ConnectionTerminated, null);
                    }
                });

                const bus = new BrowserDBusClient(ws);

                if (this._token !== null) {
                    try {
                        await bus.callMethod(
                            "re.frida.AuthenticationService16",
                            "/re/frida/AuthenticationService",
                            "re.frida.AuthenticationService16",
                            "Authenticate",
                            [this._token]
                        );
                    } catch (error) {
                        reject(error);
                        return;
                    }
                }

                const session = new BrowserHostSession(bus);

                resolve({ bus, session });
            });
        });
    }
}

export interface ClientOptions {
    tls?: TransportLayerSecurity;
    token?: string;
}

export enum TransportLayerSecurity {
    Auto = "auto",
    Disabled = "disabled",
    Enabled = "enabled"
}

export interface ProcessQueryOptions {
    pids?: number[];
    scope?: Scope;
}

export enum Scope {
    Minimal = "minimal",
    Metadata = "metadata",
    Full = "full"
}

export interface SessionOptions {
    realm?: Realm;
    persistTimeout?: number;
}

export enum Realm {
    Native = "native",
    Emulated = "emulated"
}