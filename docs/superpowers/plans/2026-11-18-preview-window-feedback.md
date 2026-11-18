# Preview Window Feedback Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 左侧目标窗口提示新文档与提交，点击“查看”才切窗打开；短暂强调后静止，已经查看的不再提醒。

**Architecture:** 通知插件维护静态窗口提醒与有限的强调时限，预览所有者在实际显示内容时确认已读。文档和 Git 共用等待目标窗口及旧文件恢复完成的导航函数。

**Tech Stack:** 现有 JavaScript、CSS、Vitest/JSDOM，不加依赖。

- [ ] 复现无限动画、列表刷新重启动画、查看后未读不消除，以及文档跨窗口打开失败。
- [ ] 补充失败测试，实现左侧窗口内的“查看”提醒、静态未读标记与有限动画，移除预览到达的右下角 toast。
- [ ] 共用安全的切窗等待逻辑；保持后台归窗、手机、收起状态和旧文件恢复契约。
- [ ] 验证相关测试及浏览器实际效果，审查、提交并推送，移植静态补丁并核对实际资源，记录工作日志。
