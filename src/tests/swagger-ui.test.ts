import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSwaggerUiHtml } from '../docs/swagger-ui.js';

test('Swagger UI renders self-hosted assets and the OpenAPI URL', () => {
  const html = renderSwaggerUiHtml('/openapi.json');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /swagger-ui-bundle\.js/);
  assert.match(html, /swagger-ui-standalone-preset\.js/);
  assert.match(html, /swagger-ui\.css/);
  assert.match(html, /url: '\/openapi\.json'/);
  assert.doesNotMatch(html, /https?:\/\/cdn\./);
});

test('Swagger UI escapes an untrusted specification URL', () => {
  const html = renderSwaggerUiHtml("/openapi.json'><script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&#39;&gt;&lt;script&gt;/);
});
