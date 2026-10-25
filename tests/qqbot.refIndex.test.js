import assert from 'node:assert/strict'
import test from 'node:test'

import { RefIndex } from '../adapter/qqbot/refIndex.js'

test('remember then get returns the index for that message id', () => {
  const index = new RefIndex()

  assert.equal(index.remember('ROBOT1.0_a', 'REFIDX_a'), true)
  assert.equal(index.get('ROBOT1.0_a'), 'REFIDX_a')
  assert.equal(index.get('ROBOT1.0_missing'), '')
})

test('incomplete pairs are ignored instead of stored', () => {
  const index = new RefIndex()

  assert.equal(index.remember('', 'REFIDX_a'), false)
  assert.equal(index.remember('ROBOT1.0_a', ''), false)
  assert.equal(index.size, 0)
})

test('the oldest entry is evicted once the limit is reached', () => {
  const index = new RefIndex({ limit: 2 })

  index.remember('a', 'REFIDX_a')
  index.remember('b', 'REFIDX_b')
  index.remember('c', 'REFIDX_c')

  assert.equal(index.size, 2)
  assert.equal(index.get('a'), '')
  assert.equal(index.get('b'), 'REFIDX_b')
  assert.equal(index.get('c'), 'REFIDX_c')
})

test('re-remembering an id keeps its original position in the queue', () => {
  const index = new RefIndex({ limit: 2 })

  index.remember('a', 'REFIDX_a1')
  index.remember('b', 'REFIDX_b')
  index.remember('a', 'REFIDX_a2')
  index.remember('c', 'REFIDX_c')

  assert.equal(index.size, 2)
  assert.equal(index.get('a'), '')
  assert.equal(index.get('b'), 'REFIDX_b')
  assert.equal(index.get('c'), 'REFIDX_c')
})
