/** 标题栏几何验收：真实布局中检查关闭、铺满与长标题避让。 */
export async function checkTeamHeader(page, selector, label, check) {
  const metrics = await page.locator(selector).evaluate(header => {
    const title = header.querySelector('.tph-title')
    const close = header.querySelector('.tph-close')
    const focus = header.querySelector('.tph-focus')
    const style = getComputedStyle(header)
    const box = header.getBoundingClientRect()
    const titleBox = title.getBoundingClientRect()
    const closeBox = close.getBoundingClientRect()
    const focusBox = focus?.getBoundingClientRect()
    const originalStyle = header.getAttribute('style')
    const originalText = title.textContent
    let narrowFits
    let safeInsets
    try {
      header.style.transition = 'none'
      header.style.setProperty('--shell-inset-right', '100px')
      header.style.setProperty('--shell-inset-left', '85px')
      const insetStyle = getComputedStyle(header)
      safeInsets = parseFloat(insetStyle.paddingRight) >= 130 && (!header.classList.contains('is-focus') || parseFloat(insetStyle.paddingLeft) >= 85)
      header.style.setProperty('--shell-inset-right', '0px')
      header.style.setProperty('--shell-inset-left', '0px')
      header.style.width = '300px'
      header.style.maxWidth = '100%'
      title.textContent = '这是需要完整保留并可关闭的很长成员或小组标题'.repeat(8)
      const narrow = header.getBoundingClientRect()
      const narrowClose = close.getBoundingClientRect()
      const narrowFocus = focus?.getBoundingClientRect()
      narrowFits = narrowClose.left >= narrow.left && narrowClose.right <= (narrowFocus?.left ?? narrow.right)
        && (!narrowFocus || narrowFocus.right <= narrow.right)
    } finally {
      title.textContent = originalText
      if (originalStyle === null) header.removeAttribute('style')
      else header.setAttribute('style', originalStyle)
    }
    return {
      height: box.height, expectedHeight: parseFloat(style.getPropertyValue('--workbench-panel-header-height')) || 38,
      titleFont: getComputedStyle(title).fontSize, tabClose: close.closest('.tph-tab') !== null,
      closeGap: closeBox.left - titleBox.right,
      focusInset: focusBox ? box.right - focusBox.right : null,
      expectedInset: parseFloat(style.paddingRight),
      focusCentered: focusBox ? Math.abs((focusBox.top + focusBox.bottom) / 2 - (box.top + box.bottom) / 2) < 1 : true,
      narrowFits, safeInsets,
    }
  })
  check(`${label}：高度与产出物栏一致`, Math.abs(metrics.height - metrics.expectedHeight) < 1, JSON.stringify(metrics))
  check(`${label}：关闭紧邻页签标题`, metrics.tabClose && metrics.closeGap >= 0 && metrics.closeGap <= 9 && metrics.titleFont === '12px', JSON.stringify(metrics))
  check(`${label}：铺满按钮位于右侧同一对齐线`, metrics.focusInset === null || Math.abs(metrics.focusInset - metrics.expectedInset) < 1.5 && metrics.focusCentered, JSON.stringify(metrics))
  check(`${label}：系统控件安全边距生效`, metrics.safeInsets, JSON.stringify(metrics))
  check(`${label}：长标题窄面板仍能关闭`, metrics.narrowFits, JSON.stringify(metrics))
}
