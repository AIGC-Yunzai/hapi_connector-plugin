export async function fetchSessions(client) {
  const data = await client.requestJson('GET', '/api/sessions')
  return data.sessions || []
}

export async function fetchSessionDetail(client, sid) {
  const data = await client.requestJson('GET', `/api/sessions/${sid}`)
  return data.session || data
}

export async function fetchMessages(client, sid, limit = 10) {
  const data = await client.requestJson('GET', `/api/sessions/${sid}/messages`, { params: { limit } })
  return data.messages || []
}

export async function sendMessage(client, sid, text, attachments = []) {
  const payload = { text }
  if (attachments.length) payload.attachments = attachments
  const res = await client.post(`/api/sessions/${sid}/messages`, { json: payload })
  if (res.ok) return [true, `已发送 -> [${sid.slice(0, 8)}]`]
  return [false, `发送失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function approvePermission(client, sid, rid, answers = null) {
  const res = await client.post(`/api/sessions/${sid}/permissions/${rid}/approve`, {
    json: answers ? { answers } : {},
  })
  if (res.ok) return [true, '已批准']
  return [false, `批准失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function denyPermission(client, sid, rid) {
  const res = await client.post(`/api/sessions/${sid}/permissions/${rid}/deny`, { json: {} })
  if (res.ok) return [true, '已拒绝']
  return [false, `拒绝失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function setPermissionMode(client, sid, mode) {
  const res = await client.post(`/api/sessions/${sid}/permission-mode`, { json: { mode } })
  if (res.ok) return [true, `权限模式已切换为: ${mode}`]
  return [false, `切换失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function setModelMode(client, sid, model) {
  const res = await client.post(`/api/sessions/${sid}/model`, { json: { model } })
  if (res.ok) return [true, `模型已切换为: ${model}`]
  return [false, `切换失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function setEffort(client, sid, effort, flavor) {
  const route = flavor === 'codex' ? 'model-reasoning-effort' : 'effort'
  const key = flavor === 'codex' ? 'modelReasoningEffort' : 'effort'
  const res = await client.post(`/api/sessions/${sid}/${route}`, { json: { [key]: effort || null } })
  const label = effort || (flavor === 'codex' ? '继承默认' : 'auto')
  if (res.ok) return [true, `推理强度已切换为: ${label}`]
  return [false, `切换失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function setCollaborationMode(client, sid, mode) {
  const res = await client.post(`/api/sessions/${sid}/collaboration-mode`, { json: { mode } })
  if (res.ok) return [true, `协作模式已切换为: ${mode}`]
  return [false, `切换失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function switchToRemote(client, sid) {
  const res = await client.post(`/api/sessions/${sid}/switch`, { json: {} })
  if (res.ok) return [true, '已切换到 remote 远程托管模式']
  return [false, `切换失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function abortSession(client, sid) {
  const res = await client.post(`/api/sessions/${sid}/abort`, { json: {} })
  if (res.ok) return [true, `已中断 [${sid.slice(0, 8)}]`]
  return [false, `中断失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function archiveSession(client, sid) {
  const res = await client.post(`/api/sessions/${sid}/archive`, { json: {} })
  if (res.ok) return [true, `归档成功 [${sid.slice(0, 8)}]`]
  return [false, `归档失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function resumeSession(client, sid) {
  const res = await client.post(`/api/sessions/${sid}/resume`, { json: {} })
  if (res.ok) {
    const data = await res.json()
    const resumedSid = data.sessionId || sid
    return [true, `已恢复 [${resumedSid.slice(0, 8)}]`, resumedSid]
  }
  return [false, `恢复失败: ${res.status} ${(await res.text()).slice(0, 200)}`, null]
}

export async function deleteSession(client, sid) {
  const res = await client.delete(`/api/sessions/${sid}`)
  if (res.ok) return [true, `删除成功 [${sid.slice(0, 8)}]`]
  return [false, `删除失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function renameSession(client, sid, name) {
  const res = await client.patch(`/api/sessions/${sid}`, { json: { name } })
  if (res.ok) return [true, `重命名成功 [${sid.slice(0, 8)}]`]
  return [false, `重命名失败: ${res.status} ${(await res.text()).slice(0, 200)}`]
}

export async function fetchMachines(client) {
  const data = await client.requestJson('GET', '/api/machines')
  return (data.machines || []).filter(machine => machine.active)
}

export async function spawnSession(client, machineId, payload) {
  const res = await client.post(`/api/machines/${machineId}/spawn`, { json: payload })
  const body = await res.json().catch(async () => ({ message: await res.text() }))
  if (res.ok && body.type === 'success') return [true, `创建成功! Session ID: ${body.sessionId}`, body.sessionId]
  return [false, `创建失败: ${res.status} ${body.message || body.error || ''}`, null]
}

export async function listMachineDirectory(client, machineId, path) {
  const data = await client.requestJson('POST', `/api/machines/${machineId}/list-directory`, { json: { path } })
  if (Array.isArray(data)) return data
  return data.entries || data.items || data.directories || data.files || []
}

export async function listDirectory(client, sid, path = '.') {
  const data = await client.requestJson('GET', `/api/sessions/${sid}/directory`, { params: { path } })
  return data.entries || []
}

export async function listFiles(client, sid, query = '', limit = 200) {
  const data = await client.requestJson('GET', `/api/sessions/${sid}/files`, { params: { query, limit } })
  return data.files || []
}

export async function readFile(client, sid, path) {
  const data = await client.requestJson('GET', `/api/sessions/${sid}/file`, { params: { path } })
  if (!data.success) return [false, data.error || data.message || '读取失败']
  return [true, data.content || '']
}

const YOLO_MODES = ['bypassPermissions', 'yolo'];
const _yoloQueues = new Map();

/**
 * Send message with delayed YOLO mode workaround.
 * If delay_yolo_mode is enabled and current permissionMode is bypassPermissions/yolo,
 * temporarily switch to default before sending, then restore after 3 seconds.
 * Uses per-session queue to serialize operations within the same session.
 */
export async function sendMessageWithDelayYolo(client, sid, text, attachments = [], options = {}) {
  const { delay_yolo_mode: delayed = false } = options;

  if (!delayed) {
    return sendMessage(client, sid, text, attachments);
  }

  const prev = _yoloQueues.get(sid) || Promise.resolve();
  const task = prev.then(async () => {
    let currentMode = 'default';
    try {
      const detail = await fetchSessionDetail(client, sid);
      currentMode = detail.permissionMode || 'default';
    } catch {
      // If detail fetch fails, send directly
      return sendMessage(client, sid, text, attachments);
    }

    const isYolo = YOLO_MODES.includes(currentMode);

    if (isYolo) {
      const [ok] = await setPermissionMode(client, sid, 'default');
      if (!ok) return sendMessage(client, sid, text, attachments);
    }

    const result = await sendMessage(client, sid, text, attachments);

    if (isYolo) {
      await new Promise(r => setTimeout(r, 3000));
      await setPermissionMode(client, sid, currentMode);
    }

    return result;
  });

  // Chain the queue: next task waits for this one to settle (success or failure)
  _yoloQueues.set(sid, task.catch(() => {}));
  return task;
}