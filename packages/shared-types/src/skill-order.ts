/**
 * 技能列表的顺序：凡是让人在一堆技能里找某一个的列表，都从这里排。
 *
 * 按眼前看到的名字排——中文名按拼音，英文名按字母，数字按大小（「技能 2」在「技能 10」前）；
 * 中文名在前、英文名在后。固定按中文排法，不随电脑的系统语言变（换台电脑顺序不变）。
 * 名字一样（连大小写差异也算）时按 id 定，保证每次顺序都一样。
 * 有先后含义的列表（开着的、加载过的）和技能市场（顺序本身代表推荐程度）不走这里。
 */
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/**
 * @param items 技能列表（不会被改动）
 * @param nameOf 取「界面上显示的那个名字」——内置技能要传译名，不是后端原名
 * @returns 排好的新数组，元素还是原来那些对象
 */
export function sortSkillsByName<T extends { id: string }>(
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  const keyed = items.map(item => ({ item, name: nameOf(item) }))
  keyed.sort((a, b) => {
    const byName = nameCollator.compare(a.name, b.name)
    if (byName !== 0) return byName
    if (a.item.id === b.item.id) return 0
    return a.item.id < b.item.id ? -1 : 1
  })
  return keyed.map(k => k.item)
}
