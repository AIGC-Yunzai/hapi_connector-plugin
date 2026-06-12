import path from 'node:path'

const _path = process.cwd().replace(/\\/g, '/')
const pluginName = path.basename(path.join(import.meta.url, '../../'))
const pluginRoot = path.join(_path, 'plugins', pluginName)
const pluginData = path.join(pluginRoot, 'data')

export { _path, pluginName, pluginRoot, pluginData }
