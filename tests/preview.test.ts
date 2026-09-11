import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptsPreviewInvite,previewConfigured,validatePreviewConfiguration} from '../server/core/preview.js';

const configured={NODE_ENV:'production',FOLIO_PREVIEW_MODE:'true',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_INVITE_CODE:'owned-preview-fixture-'.repeat(3)};

test('hosted preview requires an explicit mock-only configuration and a private invite',()=>{
  assert.equal(previewConfigured(configured),true);
  assert.doesNotThrow(()=>validatePreviewConfiguration(configured));
  assert.equal(acceptsPreviewInvite(configured.FOLIO_PREVIEW_INVITE_CODE,configured),true);
  for(const value of [undefined,'',configured.FOLIO_PREVIEW_INVITE_CODE+'x',42,'a'.repeat(257)])assert.equal(acceptsPreviewInvite(value,configured),false);
  for(const override of [{FOLIO_BILLING_MOCK:'false'},{FOLIO_PREVIEW_INVITE_CODE:''}]){
    const invalid={...configured,...override};
    assert.throws(()=>validatePreviewConfiguration(invalid),/Preview mode requires/);
    assert.equal(acceptsPreviewInvite(configured.FOLIO_PREVIEW_INVITE_CODE,invalid),false);
  }
  assert.equal(acceptsPreviewInvite(undefined,{}),true);
});
