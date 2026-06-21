/*
 * 强制测试通知样式 — 直接弹一个示例通知
 * 用法：控制台粘贴这段代码回车
 */

(function () {
  if (!('Notification' in window)) {
    console.error('❌ 浏览器不支持桌面通知');
    return;
  }

  function showTestNotification() {
    var now = new Date();
    var timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    var notif = new Notification('⚠️ 课堂走神提醒（' + timeStr + '）', {
      body: '张三  不专注 52%\n李四  不专注 45%\n王五  不专注 40%\n\n共 3 名学生走神率超标',
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#f44336"/><text x="32" y="44" text-anchor="middle" font-size="36" fill="white">⚠</text></svg>'),
      tag: 'notfocus-test',
      requireInteraction: false,
    });

    notif.onclick = function () {
      console.log('通知被点击');
    };

    console.log('✅ 测试通知已发送，请查看屏幕右上角或系统通知中心');
  }

  if (Notification.permission === 'granted') {
    showTestNotification();
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then(function (p) {
      if (p === 'granted') {
        console.log('✅ 权限已获取');
        showTestNotification();
      } else {
        console.error('❌ 未获得权限: ' + p);
      }
    });
  } else {
    console.error('❌ 权限被拒绝，请在浏览器地址栏左侧 🔒 图标处重新允许通知');
  }
})();
