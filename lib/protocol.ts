
export class Variant {
    constructor(public signature: string, public value: any) {}
}

export interface VariantDict {
    [name: string]: Variant;
}


export interface MessageBus {
    callMethod(destination: string, objectPath: string, interfaceName: string, memberName: string, args?: any[]): Promise<any>;
}

export interface HostConnection {
    bus: MessageBus;
    session: HostSession;
}


export interface HostSession {
    enumerateProcesses: (options: VariantDict) => Promise<HostProcessInfo[]>;
    attach: (pid: number, options: VariantDict) => Promise<AgentSessionId>;
    reattach: (id: AgentSessionId) => Promise<void>;
    querySystemParameters: () => Promise<VariantDict>;
}

export interface AgentSession {
    close: () => Promise<void>;
    resume: (rxBatchId: number) => Promise<number>;
    createScript: (source: string, options: VariantDict) => Promise<AgentScriptId>;
    destroyScript: (scriptId: AgentScriptId) => Promise<void>;
    loadScript: (scriptId: AgentScriptId) => Promise<void>;
    postMessages: (messages: AgentMessageRecord[], batchId: number) => Promise<void>;
    offerPeerConnection: (offerSdp: string, options: VariantDict) => Promise<string>;
    addCandidates: (candidateSdps: string[]) => Promise<void>;
    notifyCandidateGatheringDone: () => Promise<void>;
    beginMigration: () => Promise<void>;
    commitMigration: () => Promise<void>;
}

export type HostProcessInfo = [pid: number, name: string, parameters: VariantDict];

export type CrashInfo = [pid: number, processName: string, summary: string, report: string, parameters: VariantDict];

export type AgentSessionId = [handle: string];

export type AgentScriptId = [handle: number];


export class AgentMessageSink {
    constructor(private handler: AgentMessageHandler) {}

    postMessages(messages: AgentMessageRecord[], batchId: number): void {
        this.handler(messages, batchId);
    }
}

export type AgentMessageHandler = (messages: AgentMessageRecord[], batchId: number) => void;

export type AgentMessageRecord = [kind: number, scriptId: AgentScriptId, text: string, hasData: boolean, data: number[]];

export enum AgentMessageKind {
    Script = 1,
    Debugger
}