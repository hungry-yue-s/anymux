/* global Blocks, PanelSlots, Api */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.PanelSlots || !window.Blocks) return;

  function openOrchestrationModal() {
    var existing = document.getElementById('orch-modal-backdrop');
    if (existing) existing.remove();
    var ctx = window.Blocks.ui.currentContext ? window.Blocks.ui.currentContext() : {};
    var serverId = ctx.serverId || (window.Api?.activeServerId?.() || 'local');
    var client = window.Blocks.ui.client(serverId);

    var backdrop = document.createElement('div');
    backdrop.id = 'orch-modal-backdrop';
    backdrop.className = 'ms-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ms-modal orch-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Multi-Agent 编排运行');
    modal.innerHTML = '<div class="orch-head"><strong>Agent Orchestration · 任务 DAG 与租约</strong><div><button type="button" class="ms-btn" data-orch-refresh>刷新</button> <button type="button" class="ms-btn" data-orch-close>关闭</button></div></div><div class="orch-body" data-orch-body>正在加载…</div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector('[data-orch-close]').addEventListener('click', function () { backdrop.remove(); });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });

    function load() {
      var body = modal.querySelector('[data-orch-body]');
      client.get('/api/orchestration/runs').then(function (data) {
        var runs = data.runs || [];
        body.replaceChildren();
        if (!runs.length) {
          body.textContent = '暂无编排运行记录。可通过 /api/orchestration/runs 创建多 Agent DAG 任务。';
          return;
        }
        runs.forEach(function (run) {
          var card = document.createElement('div');
          card.className = 'orch-card';
          var head = document.createElement('div');
          head.className = 'wt-card-row';
          var title = document.createElement('strong');
          title.textContent = run.title + ' [' + run.status + ']';
          var expand = document.createElement('button');
          expand.type = 'button';
          expand.className = 'ms-btn';
          expand.textContent = '查看任务 DAG';
          var tasksWrap = document.createElement('div');
          expand.addEventListener('click', function () {
            client.get('/api/orchestration/runs/' + encodeURIComponent(run.id)).then(function (detail) {
              tasksWrap.replaceChildren();
              (detail.tasks || []).forEach(function (t) {
                var row = document.createElement('div');
                row.className = 'orch-task-row';
                row.textContent = t.title + ' · ' + t.agent_type + ' · ' + t.status;
                tasksWrap.appendChild(row);
              });
            }).catch(function () {});
          });
          head.append(title, expand);
          card.append(head, tasksWrap);
          body.appendChild(card);
        });
      }).catch(function (err) {
        body.textContent = '加载失败：' + (err.message || '');
      });
    }

    modal.querySelector('[data-orch-refresh]').addEventListener('click', load);
    load();
  }

  PanelSlots.commands.register({
    id: 'orchestration',
    order: 28,
    group: 'block',
    title: 'Multi-Agent 编排 · DAG 与租约',
    icon: 'overview',
    run: openOrchestrationModal,
    keywords: 'orchestration dag lease multi-agent workflow 编排 调度',
  });
})();
