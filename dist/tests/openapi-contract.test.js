import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openApiSpec } from '../docs/openapi.js';
const methodPattern = /(?:router|app)\.(get|post|patch|delete)\(\s*['"]([^'"]+)['"]/g;
const prefixes = {
    'instances.ts': '/v1/instances',
    'messages.ts': '/v1/messages',
    'webhooks.ts': '/v1/webhooks',
    'chats.ts': '/v1/chats',
    'ops.ts': '/v1/ops',
    'integrations.ts': '/v1/integrations',
};
function normalizeRoute(route) {
    return route.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';
}
function sourceOperations() {
    const result = new Set();
    for (const [file, prefix] of Object.entries(prefixes)) {
        const source = fs.readFileSync(path.resolve('src/routes', file), 'utf8');
        for (const match of source.matchAll(methodPattern)) {
            result.add(`${match[1].toUpperCase()} ${normalizeRoute(prefix + match[2])}`);
        }
    }
    const indexSource = fs.readFileSync(path.resolve('src/index.ts'), 'utf8');
    for (const match of indexSource.matchAll(methodPattern)) {
        const route = normalizeRoute(match[2]);
        if (route !== '/')
            result.add(`${match[1].toUpperCase()} ${route}`);
    }
    return result;
}
function documentedOperations() {
    const result = new Set();
    for (const [route, pathItem] of Object.entries(openApiSpec.paths)) {
        for (const method of Object.keys(pathItem)) {
            result.add(`${method.toUpperCase()} ${route}`);
        }
    }
    return result;
}
test('OpenAPI document is valid enough for Swagger and public clients', () => {
    assert.equal(openApiSpec.openapi, '3.1.0');
    assert.equal(openApiSpec.info.title, 'Beyound API');
    assert.ok(Object.keys(openApiSpec.paths).length >= 60);
    assert.ok(openApiSpec.components.securitySchemes.apiKey);
    for (const [route, pathItem] of Object.entries(openApiSpec.paths)) {
        for (const [method, operation] of Object.entries(pathItem)) {
            assert.ok(operation.summary, `${method.toUpperCase()} ${route} has no summary`);
            assert.ok(operation.responses?.['200'] || operation.responses?.['201'], `${method.toUpperCase()} ${route} has no success response`);
            assert.ok(Array.isArray(operation.tags) && operation.tags.length > 0, `${method.toUpperCase()} ${route} has no tag`);
        }
    }
});
test('every Express route is represented in OpenAPI', () => {
    const source = sourceOperations();
    const documented = documentedOperations();
    const missing = [...source].filter((operation) => !documented.has(operation)).sort();
    const stale = [...documented].filter((operation) => !source.has(operation)).sort();
    assert.deepEqual(missing, [], `Missing OpenAPI operations:\n${missing.join('\n')}`);
    assert.deepEqual(stale, [], `Stale OpenAPI operations:\n${stale.join('\n')}`);
});
