import {
    HostConnection,
    AgentSession,
    AgentSessionId,
    AgentMessageSink,
    AgentMessageHandler,
    AgentMessageRecord,
    AgentMessageKind,
    VariantDict,
} from "./protocol";
import { Crash } from "./crash";
import { Script, ScriptOptions } from "./script";
import { Signal } from "./signals";


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

export class Session {
    detached: Signal<SessionDetachedHandler>;

    _events = new BrowserEventEmitter();

    _activeSession: AgentSession;
    private _obsoleteSession: AgentSession | null = null;
    private _state: "attached" | "interrupted" | "detached" = "attached";

    private readonly _sink: AgentMessageSink;
    private _lastRxBatchId = 0;
    private _pendingMessages: PendingMessage[] = [];
    private _nextSerial = 1;
    private _pendingDeliveries = 0;

    private readonly _scripts = new Map<number, Script>();

    constructor(
            private _controller: SessionController,
            session: AgentSession,
            public pid: number,
            public id: string,
            public persistTimeout: number,
            connection: HostConnection) {
        this._activeSession = session;
        this._sink = new AgentMessageSink(this._dispatchMessages);

        this.detached = new Signal<SessionDetachedHandler>(this._events, "detached");
    }

    get isDetached(): boolean {
        return this._state === "detached";
    }

    async detach(): Promise<void> {
        if (this._state === "detached") {
            return;
        }

        this._state = "detached";

        for (const script of this._scripts.values()) {
            script._destroy();
        }
        this._scripts.clear();

        try {
            await this._activeSession.close();
        } catch (error) {
           
        }

        this._events.emit("detached", SessionDetachReason.ApplicationRequested, null);
    }

    async resume(): Promise<void> {
        if (this._state !== "interrupted") {
            return;
        }

        this._state = "attached";

        this._lastRxBatchId = await this._activeSession.resume(this._lastRxBatchId);
        this._deliverPendingMessages();
    }

    async createScript(source: string, options: ScriptOptions = {}): Promise<Script> {
        const rawOptions: VariantDict = {};
        const { name, runtime } = options;
        if (name !== undefined) {
            rawOptions.name = { signature: "s", value: name };
        }
        if (runtime !== undefined) {
            rawOptions.runtime = { signature: "s", value: runtime };
        }

        const id = await this._activeSession.createScript(source, rawOptions);
        const script = new Script(this, id);
        this._scripts.set(id[0], script);

        script._events.once("destroyed", () => {
            this._scripts.delete(id[0]);
        });

        return script;
    }

    _postToAgent(record: AgentMessageRecord): void {
        this._pendingMessages.push({
            serial: this._nextSerial++,
            record,
        });

        this._deliverPendingMessages();
    }

    _handleIncomingMessages(messages: AgentMessageRecord[], batchId: number): void {
        console.log('Session._handleIncomingMessages called:', { messages, batchId });
        this._sink.postMessages(messages, batchId);
    }

    private _deliverPendingMessages(): void {
        if (this._pendingDeliveries > 0) {
            return;
        }

        const messages = this._pendingMessages;
        if (messages.length === 0) {
            return;
        }

        const batchId = messages[messages.length - 1].serial;
        const records = messages.map(m => m.record);

        this._pendingMessages = [];
        this._pendingDeliveries++;

        this._activeSession.postMessages(records, batchId).then(() => {
            this._pendingDeliveries--;
            this._deliverPendingMessages();
        }).catch(() => {
            this._pendingDeliveries--;
        });
    }

    private _dispatchMessages = (messages: AgentMessageRecord[], batchId: number): void => {
        console.log('Session._dispatchMessages called:', { messages, batchId, scriptsCount: this._scripts.size });
        this._lastRxBatchId = batchId;

        for (const [kind, scriptId, text, hasData, data] of messages) {
            console.log('Processing message:', { kind, scriptId, text, hasData, dataLength: data?.length });
            const script = this._scripts.get(scriptId[0]);
            if (script === undefined) {
                console.log('Script not found for scriptId:', scriptId);
                continue;
            }

            let message;
            try {
                message = JSON.parse(text);
                console.log('Parsed message:', message);
            } catch (error) {
                console.error('Failed to parse message text:', text, error);
                continue;
            }

            const binaryData = hasData ? new Uint8Array(data).buffer : null;
            console.log('Dispatching to script:', { message, binaryData });
            script._dispatchMessage(message, binaryData);
        }
    }

    _onDetached(reason: SessionDetachReason, crash: Crash | null): void {
        if (this._state === "detached") {
            return;
        }

        this._state = "detached";

        for (const script of this._scripts.values()) {
            script._destroy();
        }
        this._scripts.clear();

        this._events.emit("detached", reason, crash);
    }
}

export type SessionDetachedHandler = (reason: SessionDetachReason, crash: Crash | null) => void;

export enum SessionDetachReason {
    ApplicationRequested = "application-requested",
    ProcessReplaced = "process-replaced", 
    ProcessTerminated = "process-terminated",
    ServerTerminated = "server-terminated",
    DeviceLost = "device-lost",
    ConnectionTerminated = "connection-terminated"
}

export interface SessionController {
   
}

interface PendingMessage {
    serial: number;
    record: AgentMessageRecord;
}


export interface PeerOptions {
    stun?: string[];
    turn?: TurnServer[];
}

export interface TurnServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface Relay {
    kind: RelayKind;
    address: string;
    username: string;
    password: string;
}

export enum RelayKind {
    TurnUdp = "turn-udp",
    TurnTcp = "turn-tcp",
    TurnTls = "turn-tls"
}