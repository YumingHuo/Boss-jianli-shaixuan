import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { LocalDatabase } from '../src/core/storage';
import { newState } from '../src/core/types';
it('新的数据库实例能读取已提交的持久状态',async()=>{const db=new LocalDatabase();const s=newState();s.paused=false;await db.save(s);expect((await new LocalDatabase().load()).paused).toBe(false);});
