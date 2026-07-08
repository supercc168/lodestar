import { describe, expect, test } from 'bun:test'
import { parseClaudeModelProfile } from './config'

describe('parseClaudeModelProfile', () => {
  test('env_<NAME> 扁平标量收进 profile.env', () => {
    const profile = parseClaudeModelProfile({
      model: 'glm-5.2[1m]',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      auth_token: 'tok',
      effort: 'xhigh',
      env_ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      env_ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    })
    expect(profile.model).toBe('glm-5.2[1m]')
    expect(profile.base_url).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(profile.env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
    })
  })

  test('env_ 空值过滤、env_ 后无名为空不收、非 env_ 字段不受影响', () => {
    const profile = parseClaudeModelProfile({
      model: 'glm-5.2',
      env_ANTHROPIC_DEFAULT_HAIKU_MODEL: '', // 空值不收
      env_: 'nope', // env_ 后为空不收
      description: 'x',
    })
    expect(profile.env).toBeUndefined()
    expect(profile.description).toBe('x')
    expect(profile.model).toBe('glm-5.2')
  })
})
