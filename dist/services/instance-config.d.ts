export declare const INSTANCE_EVENT_NAMES: readonly ["APPLICATION_STARTUP", "CALL", "CHATS_DELETE", "CHATS_SET", "CHATS_UPDATE", "CHATS_UPSERT", "CONNECTION_UPDATE", "CONTACTS_SET", "CONTACTS_UPDATE", "CONTACTS_UPSERT", "GROUP_PARTICIPANTS_UPDATE", "GROUP_UPDATE", "GROUPS_UPSERT", "LABELS_ASSOCIATION", "LABELS_EDIT", "LOGOUT_INSTANCE", "MESSAGES_DELETE", "MESSAGES_SET", "MESSAGES_UPDATE", "MESSAGES_UPSERT", "PRESENCE_UPDATE", "QRCODE_UPDATED", "REMOVE_INSTANCE", "SEND_MESSAGE", "TYPEBOT_CHANGE_STATUS", "TYPEBOT_START"];
export type InstanceEventName = (typeof INSTANCE_EVENT_NAMES)[number];
export interface ProxyConfig {
    enabled: boolean;
    protocol: string;
    host: string;
    port: string;
    username: string;
    password: string;
}
export interface GeneralConfig {
    rejectCalls: boolean;
    ignoreGroups: boolean;
    alwaysOnline: boolean;
    autoReadMessages: boolean;
    syncFullHistory: boolean;
    readStatus: boolean;
}
export interface EventsConfig {
    webhookUrl: string;
    toggles: Record<InstanceEventName, boolean>;
}
export interface InstancePanelConfig {
    instance: string;
    proxy: ProxyConfig;
    general: GeneralConfig;
    events: EventsConfig;
    createdAt: number;
    updatedAt: number;
}
export interface InstanceEventDispatchResult {
    ok: boolean;
    skipped: boolean;
    status?: number;
    error?: string;
}
export declare function getInstancePanelConfig(instance: string): InstancePanelConfig;
export declare function updateInstanceProxy(instance: string, patch: Partial<ProxyConfig>): InstancePanelConfig;
export declare function updateInstanceGeneral(instance: string, patch: Partial<GeneralConfig>): InstancePanelConfig;
export declare function updateInstanceEvents(instance: string, patch: {
    webhookUrl?: string;
    toggles?: Partial<Record<InstanceEventName, boolean>>;
}): InstancePanelConfig;
export declare function getInstanceGeneral(instance: string): GeneralConfig;
export declare function emitInstanceEvent(instance: string, eventName: InstanceEventName, payload: unknown, options?: {
    ignoreToggle?: boolean;
}): Promise<InstanceEventDispatchResult>;
