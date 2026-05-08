export interface OutboundUrlValidationOptions {
    allowPrivateNetwork?: boolean;
}
export interface OutboundUrlValidationResult {
    ok: boolean;
    normalizedUrl?: string;
    error?: 'invalid_url' | 'invalid_protocol' | 'url_credentials_not_allowed' | 'private_network_url_not_allowed';
    details?: string;
}
export declare function validateOutboundUrl(input: unknown, options?: OutboundUrlValidationOptions): OutboundUrlValidationResult;
