/* global Blocks, PanelSlots, AppShell */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.PanelSlots || !window.Blocks) return;

  function openAutomationsModal() {
    var existing = document.getElementById('auto-modal-backdrop');
    if (existing) existing.remove();
    var serverId = (window.Blocks.ui.currentContext && window.Blocks.ui.currentContext().serverId) || (window.Api?.activeServerId?.() || 'local');
    var client = window.Blocks.ui.client(serverId);

    var backdrop = document.createElement('div');
    backdrop.id = 'auto-modal-backdrop';
    backdrop.className = 'ms-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ms-modal wt-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '定时自动化任务');
    modal.innerHTML = '<div class="wt-head"><strong>Automations · Cron 定时任务</strong><button type="button" class="ms-btn" data-auto-close>关闭</button></div>'
      + '<div class="wt-body">'
      + '<form class="wt-form" data-auto-form>'
      + '<input type="text" class="wt-input" name="name" placeholder="任务名称" required>'
      + '<input type="text" class="wt-input" name="schedule" placeholder="Cron 表达式，如 */15 * * * *" required>'
      + '<input type="text" class="wt-input" name="command" placeholder="执行的 Shell 命令" required>'
      + '<button type="submit" class="ms-btn primary">添加任务</button>'
      + '</form>'
      + '<div data-auto-list>正在加载…</div>'
      + '</div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector('[data-auto-close]').addEventListener('click', function () { backdrop.remove(); });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });

    function refresh() {
      var list = modal.querySelector('[data-auto-list]');
      client.get('/api/automations').then(function (data) {
        var jobs = data.jobs || [];
        list.replaceChildren();
        if (!jobs.length) { list.textContent = '暂无定时自动化任务。'; return; }
        jobs.forEach(function (job) {
          var card = document.createElement('div');
          card.className = 'wt-card';
          var row = document.createElement('div');
          row.className = 'wt-card-row';
          var title = document.createElement('span');
          title.className = 'wt-branch';
          title.textContent = job.name + ' (' + job.schedule + ')' + (job.lastStatus ? ' · 上次: ' + job.lastStatus : '');
          var acts = document.createElement('div');
          acts.className = 'wt-actions';
          var runBtn = document.createElement('button');
          runBtn.type = 'button'; runBtn.className = 'ms-btn'; runBtn.textContent = '立即执行';
          runBtn.addEventListener('click', function () {
            client.post('/api/automations/' + encodeURIComponent(job.id) + '/run', {}).then(function (res) {
              window.AppShell?.toast?.('执行完成: ' + (res.run?.status || 'ok'));
              refresh();
            }).catch(function (err) { window.AppShell?.toast?.(err.message || '执行失败'); });
          });
          var delBtn = document.createElement('button');
          delBtn.type = 'button'; delBtn.className = 'ms-btn'; delBtn.textContent = '删除';
          delBtn.addEventListener('click', function () {
            client.del('/api/automations/' + encodeURIComponent(job.id)).then(refresh);
          });
          acts.append(runBtn, delBtn);
          row.append(title, acts);
          var cmd = document.createElement('div');
          cmd.className = 'wt-path';
          cmd.textContent = job.command;
          card.append(row, cmd);
          list.appendChild(card);
        });
      }).catch(function (err) { list.textContent = '加载失败：' + (err.message || ''); });
    }

    modal.querySelector('[data-auto-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      client.post('/api/automations', {
        name: form.name.value.trim(),
        schedule: form.schedule.value.trim(),
        command: form.command.value.trim(),
      }).then(function () {
        form.reset();
        refresh();
      }).catch(function (err) { window.AppShell?.toast?.(err.message || '添加失败'); });
    });

    refresh();
  }

  PanelSlots.commands.register({
    id: 'automations',
    order: 27,
    group: 'block',
    title: 'Automations · Cron 定时任务',
    icon: 'activity',
    run: openAutomationsModal,
    keywords: 'automation cron schedule timer task 定时 自动 任务',
  });
})();
