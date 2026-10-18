import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { ProfileError } from './profile.mjs'
import { canonical, captureRecord, versionKey } from './snapshot.mjs'

function rootPath(root) {
  if (typeof root !== 'string' || !root.length || root.includes('\0')) throw new ProfileError('STORE_INVALID')
  return resolve(root)
}
async function checkRoot(root, io) {
  try {
    const stat = await io.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProfileError('STORE_INVALID')
  } catch (error) {
    if (error instanceof ProfileError) throw error
    throw new ProfileError(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'STORE_INVALID' : 'STORE_IO')
  }
}
async function syncDirectory(path, io) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export async function initStore(root, { io = fs } = {}) {
  const path = rootPath(root), parent = dirname(path)
  await checkRoot(parent, io)
  try {
    try { await io.mkdir(path, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await checkRoot(path, io)
    await syncDirectory(parent, io)
    return { initialized: true }
  } catch (error) {
    if (error instanceof ProfileError) throw error
    throw new ProfileError('STORE_IO')
  }
}

async function load(path, projectId, profileVersion, io) {
  let handle
  try {
    handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ProfileError('SNAPSHOT_CORRUPT')
    const bytes = await handle.readFile()
    if (bytes.length > 2 * 1024 * 1024) throw new ProfileError('SNAPSHOT_CORRUPT')
    let parsed
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new ProfileError('SNAPSHOT_CORRUPT') }
    const record = captureRecord(parsed)
    if (!bytes.equals(Buffer.from(canonical(record) + '\n')) || record.payload.project_id !== projectId || record.payload.profile_version !== profileVersion) {
      throw new ProfileError('SNAPSHOT_CORRUPT')
    }
    return record
  } catch (error) {
    if (error instanceof ProfileError) throw error
    throw new ProfileError(error.code === 'ELOOP' ? 'SNAPSHOT_CORRUPT' : 'STORE_IO')
  } finally {
    if (handle) {
      try { await handle.close() } catch { throw new ProfileError('STORE_IO') }
    }
  }
}

export async function readSnapshot(root, { projectId, profileVersion }, { io = fs } = {}) {
  const path = rootPath(root), key = versionKey(projectId, profileVersion)
  await checkRoot(path, io)
  return load(join(path, `${key}.snapshot.json`), projectId, profileVersion, io)
}

export async function publishSnapshot(root, record, { io = fs } = {}) {
  // Capture synchronously, before even the first filesystem await.
  const path = rootPath(root), captured = captureRecord(record)
  const { project_id: projectId, profile_version: profileVersion } = captured.payload
  const final = join(path, `${versionKey(projectId, profileVersion)}.snapshot.json`)
  const temp = join(path, `.${randomUUID()}.tmp`), bytes = canonical(captured) + '\n'
  await checkRoot(path, io)
  let handle, ownTemp = false
  try {
    handle = await io.open(temp, 'wx', 0o600); ownTemp = true
    await handle.writeFile(bytes, { encoding: 'utf8' })
    await handle.sync()
    await handle.close(); handle = undefined
    try { await io.link(temp, final) }
    catch (error) {
      if (error.code !== 'EEXIST') throw new ProfileError('PUBLICATION_UNCERTAIN')
      const existing = await load(final, projectId, profileVersion, io)
      if (canonical(existing) !== canonical(captured)) throw new ProfileError('PROFILE_VERSION_CONFLICT')
    }
    try { await syncDirectory(path, io) }
    catch { throw new ProfileError('PUBLICATION_UNCERTAIN') }
    return captured
  } catch (error) {
    if (error instanceof ProfileError) throw error
    throw new ProfileError('STORE_IO')
  } finally {
    if (handle) { try { await handle.close() } catch { /* A failed close never publishes. */ } }
    if (ownTemp) { try { await io.unlink(temp) } catch { /* Ignored orphan: final is never removed. */ } }
  }
}
