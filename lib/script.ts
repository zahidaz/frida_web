import {
    AgentSession,
    AgentScriptId,
    AgentMessageRecord,
    AgentMessageKind,
} from "./protocol";
import {
    SignalSource,
    Signal,
    SignalHandler,
    SignalAdapter,
} from "./signals";


class BrowserEventEmitter {
    private listeners = new Map<string, Function[]>();

    addListener(event: string, listener: Function): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(listener);
    }

    removeListener(event: string, listener: Function): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            const index = eventListeners.indexOf(listener);
            if (index > -1) {
                eventListeners.splice(index, 1);
            }
        }
    }

    emit(event: string, ...args: any[]): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            eventListeners.forEach(listener => listener(...args));
        }
    }

    once(event: string, listener: Function): void {
        const onceWrapper = (...args: any[]) => {
            listener(...args);
            this.removeListener(event, onceWrapper);
        };
        this.addListener(event, onceWrapper);
    }
}

export class Script {
    destroyed: Signal<ScriptDestroyedHandler>;
    message: Signal<ScriptMessageHandler>;

    _events = new BrowserEventEmitter();

    private readonly _id: AgentScriptId;
    private _state: "created" | "destroyed" = "created";
    private readonly _exportsProxy: ScriptExports;
    private _logHandlerImpl: ScriptLogHandler = log;

    constructor(
            private _controller: ScriptController,
            id: AgentScriptId) {
        this._id = id;

        const services = new ScriptServices(this, this._events);

        const rpcController: RpcController = services;
        this._exportsProxy = makeScriptExportsProxy(rpcController);

        const source: SignalSource = services;
        this.destroyed = new Signal<ScriptDestroyedHandler>(source, "destroyed");
        this.message = new Signal<ScriptMessageHandler>(source, "message");
    }

    get isDestroyed(): boolean {
        return this._state === "destroyed";
    }

    get exports(): ScriptExports {
        return this._exportsProxy;
    }

    get logHandler(): ScriptLogHandler {
        return this._logHandlerImpl;
    }

    set logHandler(handler: ScriptLogHandler) {
        this._logHandlerImpl = handler;
    }

    get defaultLogHandler(): ScriptLogHandler {
        return log;
    }

    load(): Promise<void> {
        return this._controller._activeSession.loadScript(this._id);
    }

    async unload(): Promise<void> {
        await this._controller._activeSession.destroyScript(this._id);

        this._destroy();
    }

    post(message: any, data: ArrayBuffer | null = null): void {
        const hasData = data !== null;
        const record: AgentMessageRecord = [
            AgentMessageKind.Script,
            this._id,
            JSON.stringify(message),
            hasData,
            hasData ? Array.from(new Uint8Array(data)) : []
        ];
        this._controller._postToAgent(record);
    }

    _destroy() {
        if (this._state === "destroyed") {
            return;
        }

        this._state = "destroyed";
        this._events.emit("destroyed");
    }

    _dispatchMessage(message: Message, data: ArrayBuffer | null): void {
        this._events.emit("message", message, data);
    }
}

export interface ScriptOptions {
    name?: string;
    runtime?: ScriptRuntime;
}

export enum ScriptRuntime {
    Default = "default",
    QJS = "qjs",
    V8 = "v8",
}

export type ScriptDestroyedHandler = () => void;
export type ScriptMessageHandler = (message: Message, data: ArrayBuffer | null) => void;
export type ScriptLogHandler = (level: LogLevel, text: string) => void;

export type Message = SendMessage | ErrorMessage | LogMessage;

export enum MessageType {
    Send = "send",
    Error = "error",
    Log = "log",
}

export interface SendMessage {
    type: MessageType.Send;
    payload: any;
}

export interface ErrorMessage {
    type: MessageType.Error;
    description: string;
    stack?: string;
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
}

export interface LogMessage {
    type: MessageType.Log;
    level: LogLevel;
    payload: string;
}

export interface ScriptExports {
    [name: string]: (...args: any[]) => Promise<any>;
}

export enum LogLevel {
    Info = "info",
    Warning = "warning",
    Error = "error"
}

export interface ScriptController {
    _activeSession: AgentSession;
    _postToAgent(record: AgentMessageRecord): void;
}

class ScriptServices extends SignalAdapter implements RpcController {
    private pendingRequests: { [id: string]: (error: Error | null, result?: any) => void } = {};
    private nextRequestId: number = 1;

    constructor(private script: Script, events: BrowserEventEmitter) {
        super(events);

        this.signalSource.addListener("destroyed", this.onDestroyed);
        this.signalSource.addListener("message", this.onMessage);
    }

    protected getProxy(name: string, userHandler: SignalHandler): SignalHandler | null {
        if (name === "message") {
            return (message, data) => {
                if (!isInternalMessage(message)) {
                    userHandler(message, data);
                }
            };
        }

        return null;
    }

    private onDestroyed = () => {
        this.signalSource.removeListener("destroyed", this.onDestroyed);
        this.signalSource.removeListener("message", this.onMessage);
    }

    private onMessage = (message: Message, data: ArrayBuffer | null) => {
        if (message.type === MessageType.Send && isRpcSendMessage(message)) {
            const [, id, operation, ...params] = message.payload;
            this.onRpcMessage(id, operation, params, data);
        } else if (isLogMessage(message)) {
            const opaqueMessage: any = message;
            const logMessage: LogMessage = opaqueMessage;
            this.script.logHandler(logMessage.level, logMessage.payload);
        }
    }

    request(operation: string, params: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextRequestId++;
            const strId = id.toString();

            this.pendingRequests[strId] = (error: Error | null, result?: any) => {
                delete this.pendingRequests[strId];

                if (error !== null) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };

            this.script.post(["frida:rpc", id, operation, ...params]);
        });
    }

    private onRpcMessage(id: number, operation: string, params: any[], data: ArrayBuffer | null): void {
        const strId = id.toString();
        const completionHandler = this.pendingRequests[strId];
        if (completionHandler === undefined) {
            return;
        }

        let error: Error | null = null;
        let result: any;
        if (operation === "ok") {
            result = params[0];
        } else if (operation === "error") {
            const [message, name, stack] = params;
            error = new Error(message);
            error.name = name;
            error.stack = stack;
        }

        completionHandler(error, result);
    }
}

interface RpcController {
    request(operation: string, params: any[]): Promise<any>;
}

function makeScriptExportsProxy(rpc: RpcController): ScriptExports {
    return new Proxy({}, {
        get(target, property, receiver) {
            if (typeof property === "string") {
                return async (...args: any[]) => {
                    return await rpc.request("call", [property, args]);
                };
            } else {
                return Reflect.get(target, property, receiver);
            }
        },

        set(target, property, value, receiver) {
            return Reflect.set(target, property, value, receiver);
        },

        has(target, property) {
            return Reflect.has(target, property);
        },

        ownKeys(target) {
            return Reflect.ownKeys(target);
        },

        getOwnPropertyDescriptor(target, property) {
            return Reflect.getOwnPropertyDescriptor(target, property);
        }
    });
}

function isInternalMessage(message: Message): boolean {
    return message.type === MessageType.Send &&
           typeof message.payload === "object" &&
           Array.isArray(message.payload) &&
           message.payload.length >= 1 &&
           message.payload[0] === "frida:rpc";
}

function isRpcSendMessage(message: SendMessage): boolean {
    return typeof message.payload === "object" &&
           Array.isArray(message.payload) &&
           message.payload.length >= 1 &&
           message.payload[0] === "frida:rpc";
}

function isLogMessage(message: Message): boolean {
    return message.type === MessageType.Log ||
           (message.type === MessageType.Send &&
            typeof message.payload === "object" &&
            message.payload !== null &&
            (message.payload as any).type === "log");
}

function log(level: LogLevel, text: string): void {
    const fn = (console as any)[level] || console.log;
    fn(`[Script] ${text}`);
}