// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseMayExist} from '../app/database-presence.js';

test('a successful inventory distinguishes only the requested database name',async()=>{
  const factory={databases:async()=>[{name:'SYNTHETIC-other',version:7},{name:'SYNTHETIC-kept',version:1}]};
  assert.equal(await databaseMayExist('SYNTHETIC-kept',factory),true);
  assert.equal(await databaseMayExist('SYNTHETIC-absent',factory),false);
  assert.equal(await databaseMayExist('SYNTHETIC-absent',{databases:async()=>[]}),false);
});

test('absence is not cached across a subsequent first write or database change',async()=>{
  const names=[];let calls=0;
  const factory={async databases(){calls++;return names.map(name=>({name,version:1}));}};
  assert.equal(await databaseMayExist('SYNTHETIC-created-later',factory),false);
  names.push('SYNTHETIC-created-later');
  assert.equal(await databaseMayExist('SYNTHETIC-created-later',factory),true);
  assert.equal(calls,2);
});

test('unavailable discovery falls back to ordinary open, including a missing factory',async()=>{
  for(const factory of [null,{}, {databases:null}])assert.equal(await databaseMayExist('SYNTHETIC',factory),true);
});

test('inventory denial and synchronous exceptions are not treated as an empty database',async()=>{
  for(const databases of [()=>{throw new Error('SYNTHETIC synchronous denial');},async()=>{throw new DOMException('SYNTHETIC denial','SecurityError');}]){
    assert.equal(await databaseMayExist('SYNTHETIC',{databases}),true);
  }
});

test('malformed inventory falls back rather than hiding existing storage',async()=>{
  for(const value of [undefined,null,{},[null],[{}],[{name:42}],[{name:'SYNTHETIC-other'},{name:null}]]){
    assert.equal(await databaseMayExist('SYNTHETIC',{databases:async()=>value}),true);
  }
});

test('inventory calls retain the IndexedDB factory receiver',async()=>{
  const factory={databases(){assert.equal(this,factory);return Promise.resolve([]);}};
  assert.equal(await databaseMayExist('SYNTHETIC',factory),false);
});
