import { useI18n } from 'vue-i18n'

/**
 * 内置技能在界面上的名字和简介。
 * 译名表在 `@shared/builtin-skill-names`，经设置的语言包提供；
 * 表里没有的（后来新增、还没翻的）就用后端给的原文。
 * 设置页、侧栏技能状态弹层、输入框技能面板都从这里取，不各抄一份。
 */
export function useBuiltinSkillText() {
  const { t, te } = useI18n()

  const builtinSkillName = (skill: { id: string; name: string }): string => {
    const key = `skillSettings.builtinSkillNames.${skill.id}`
    return te(key) ? String(t(key)) : skill.name
  }

  const builtinSkillDescription = (skill: { id: string; description?: string }): string => {
    const key = `skillSettings.builtinSkillDescs.${skill.id}`
    return te(key) ? String(t(key)) : (skill.description ?? '')
  }

  return { builtinSkillName, builtinSkillDescription }
}
