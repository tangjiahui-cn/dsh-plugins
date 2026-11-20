import { ReleaseError } from '../util.mjs'
import { npmTarget } from './npm.mjs'

const targets = new Map([['npm', npmTarget]])

export const targetIds = [...targets.keys()]

/** 取发布目标；未知目标列出可用值。 */
export function getTarget(id = 'npm') {
  const target = targets.get(id)
  if (target === undefined) {
    throw new ReleaseError(`未知发布目标：${id}；可用目标：${targetIds.join('、')}`)
  }
  return target
}

export { npmTarget }
