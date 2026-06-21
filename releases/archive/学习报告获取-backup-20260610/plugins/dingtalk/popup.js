// 钉钉数据提取助手 - 弹出页面脚本
console.log('🔧 popup.js 开始执行');

document.addEventListener('DOMContentLoaded', function() {
  console.log('🔧 DOM 加载完成');
  
  // 检查按钮是否存在
  const btn = document.getElementById('btn-show-panel');
  const helpBtn = document.getElementById('btn-help');
  console.log('🔧 按钮元素:', btn, helpBtn);
  
  if (!btn) {
    console.error('❌ 找不到按钮 #btn-show-panel');
    return;
  }
  
  // 加载保存的去重模式
  chrome.storage.sync.get(['dedupMode'], function(result) {
    console.log('🔧 加载去重模式:', result.dedupMode);
    if (result.dedupMode) {
      document.getElementById('dedup-mode').value = result.dedupMode;
    }
  });

  // 保存去重模式选择
  document.getElementById('dedup-mode').addEventListener('change', function() {
    chrome.storage.sync.set({dedupMode: this.value});
    console.log('🔧 保存去重模式:', this.value);
  });

  // 显示成功提示
  function showSuccess(dedupMode) {
    alert('✓ 控制面板已显示在页面右上角！\n\n当前去重模式：' + 
      (dedupMode === 'id+time' ? '按 ID + 时间去重' : '仅按 ID 去重') +
      '\n\n点击"开始提取"按钮开始提取数据。');
  }

  // 点击显示控制面板
  btn.addEventListener('click', async function() {
    console.log('🔧 点击了显示控制面板按钮');
    
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

    // 获取当前选择去重模式
    const dedupMode = document.getElementById('dedup-mode').value;
    console.log('🔧 去重模式:', dedupMode);

    if (!tab) {
      alert('无法获取当前标签页，请刷新页面重试！');
      return;
    }

    try {
      // 方法1：尝试使用 sendMessage
      console.log('🔧 尝试 sendMessage');
      await chrome.tabs.sendMessage(tab.id, {
        action: 'showPanel',
        dedupMode: dedupMode
      });
      showSuccess(dedupMode);
    } catch (error) {
      console.log('sendMessage 失败:', error.message);
      
      // 方法2：使用 executeScript 直接调用
      try {
        console.log('🔧 尝试 executeScript');
        await chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: (mode) => {
            window.dedupMode = mode;
            if (typeof createControlPanel === 'function') {
              createControlPanel();
              return 'success';
            } else {
              return 'function not found: ' + typeof createControlPanel;
            }
          },
          args: [dedupMode]
        });
        showSuccess(dedupMode);
      } catch (execError) {
        console.error('executeScript 也失败:', execError);
        alert('请刷新钉钉页面后再试！\n错误: ' + execError.message);
      }
    }
  });

  // 点击帮助按钮
  helpBtn.addEventListener('click', function() {
    const dedupMode = document.getElementById('dedup-mode').value;
    
    alert('📖 使用说明\n\n' +
      '1. 选择去重模式（默认按 ID + 时间去重）\n' +
      '2. 点击"显示控制面板"按钮\n' +
      '3. 在页面右上角会显示控制面板\n' +
      '4. 点击"开始提取"按钮\n' +
      '5. 等待自动滚动提取（约5-10分钟）\n' +
      '6. 数据会自动下载为CSV文件\n\n' +
      '💡 去重模式说明：\n' +
      '- 默认（ID+时间）：同一用户在不同时间提交保留多条\n' +
      '- 仅按ID：同一用户只保留一条记录\n\n' +
      '💡 其他提示：\n' +
      '- 可以通过滚动延迟调节提取速度\n' +
      '- 点击"停止"按钮可随时暂停\n' +
      '- 点击"下载CSV"可手动下载已提取的数据');
  });
});
