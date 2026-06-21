#!/usr/bin/env node
/**
 * 管理员 CLI 工具
 * 用法:
 *   node admin-cli.js change-password          # 交互式修改管理员密码
 *   node admin-cli.js change-password <新密码>  # 直接修改
 *   node admin-cli.js list-users               # 列出所有用户
 *   node admin-cli.js approve <用户名>          # 审批用户
 *   node admin-cli.js settings                 # 查看系统设置
 *   node admin-cli.js set-approval auto|manual  # 修改审批模式
 */

const db = require('./db');
const bcrypt = require('bcryptjs');
const readline = require('readline');

db.init();

const args = process.argv.slice(2);
const cmd = args[0];

function rlPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function changePassword(newPwd) {
  const admins = db.listUsers().filter(u => u.role === 'admin');
  if (admins.length === 0) { console.log('❌ 没有管理员账号'); return; }

  const admin = admins[0];
  if (!newPwd) {
    newPwd = await rlPrompt('新密码: ');
  }
  if (newPwd.length < 6) { console.log('❌ 密码至少6位'); return; }

  db.changePassword(admin.id, newPwd);
  console.log(`✅ 管理员 ${admin.username} 密码已更新`);
}

function listUsers() {
  const users = db.listUsers();
  console.log('\n用户名         角色      状态      注册时间');
  console.log('─'.repeat(70));
  users.forEach(u => {
    const time = new Date(u.created_at).toLocaleString('zh-CN');
    console.log(`${u.username.padEnd(15)} ${u.role.padEnd(9)} ${u.status.padEnd(9)} ${time}`);
  });
  const stats = db.getStats();
  console.log(`\n总计: ${stats.total}  |  活跃: ${stats.active}  |  待审批: ${stats.pending}`);
}

async function approveUser(username) {
  if (!username) username = await rlPrompt('用户名: ');
  const user = db.getUserByUsername(username);
  if (!user) { console.log('❌ 用户不存在'); return; }
  if (user.status !== 'pending') { console.log('❌ 用户不在待审批状态'); return; }
  db.approveUser(user.id);
  console.log(`✅ ${username} 已通过审批`);
}

function showSettings() {
  console.log(`审批模式:       ${db.getSetting('approval_mode')}`);
  console.log(`开放注册:       ${db.getSetting('registration_enabled')}`);
}

function setApproval(mode) {
  if (!['auto', 'manual'].includes(mode)) { console.log('用法: node admin-cli.js set-approval auto|manual'); return; }
  db.setSetting('approval_mode', mode);
  console.log(`✅ 审批模式已设为: ${mode}`);
}

// ─── 主逻辑 ─────────────────────────────────────
(async () => {
  switch (cmd) {
    case 'change-password':
      await changePassword(args[1]); break;
    case 'list-users':
      listUsers(); break;
    case 'approve':
      await approveUser(args[1]); break;
    case 'settings':
      showSettings(); break;
    case 'set-approval':
      setApproval(args[1]); break;
    case 'set-registration':
      if (!['true', 'false'].includes(args[1])) { console.log('用法: node admin-cli.js set-registration true|false'); break; }
      db.setSetting('registration_enabled', args[1]);
      console.log(`✅ 注册已${args[1]==='true'?'开启':'关闭'}`); break;
    default:
      console.log(`
管理工具用法:
  node admin-cli.js change-password [新密码]   修改管理员密码
  node admin-cli.js list-users                 列出所有用户
  node admin-cli.js approve [用户名]           审批用户
  node admin-cli.js settings                   查看系统设置
  node admin-cli.js set-approval auto|manual   修改审批模式
  node admin-cli.js set-registration true|false 开关注册
      `);
  }
})();
