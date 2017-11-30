'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import { flatten } from './utils';
import * as globby from 'globby';
import * as _ from 'lodash';

const I18N_GLOB = `${vscode.workspace.rootPath}/langs/zh_CN/*.ts`;

export function activate(context: vscode.ExtensionContext) {
	let finalLangObj = {};

	let activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		triggerUpdateDecorations();
	}

	// 监听 langs/ 文件夹下的变化，重新生成 finalLangObj
	const watcher = vscode.workspace.createFileSystemWatcher(I18N_GLOB);
	watcher.onDidChange(() => finalLangObj = getSuggestLangObj());
	watcher.onDidCreate(() => finalLangObj = getSuggestLangObj());
	watcher.onDidDelete(() => finalLangObj = getSuggestLangObj());
	finalLangObj = getSuggestLangObj();

	// 识别到出错时点击小灯泡弹出的操作
	vscode.languages.registerCodeActionsProvider('typescriptreact', {
    provideCodeActions: function(document, range, context, token) {
			const targetStr = targetStrs.find(t => range.intersection(t.range) !== undefined);
			if (targetStr) {
				const sameTextStrs = targetStrs.filter(t => t.text === targetStr.text);
				const text = targetStr.text;

				const actions = [];
				for (const key in finalLangObj) {
					if (finalLangObj[key].includes(text)) {
						actions.push({
							title: `抽取为 \`I18N.${key}\``,
							command: "vscode-i18n-linter.extractI18N",
							arguments: [{
								targets: sameTextStrs,
								varName: `I18N.${key}`,
							}]
						});
					}
				}

				return actions.concat({
					title: `抽取为自定义 I18N 变量（共${sameTextStrs.length}处）`,
					command: "vscode-i18n-linter.extractI18N",
					arguments: [{
						targets: sameTextStrs,
					}],
				});
			}
		}
	});

	// 点击小灯泡后进行替换操作
	vscode.commands.registerCommand('vscode-i18n-linter.extractI18N', (args) => {
		new Promise(resolve => {
			// 若变量名已确定则直接开始替换
			if (args.varName) {
				return resolve(args.varName);
			}

			// 否则要求用户输入变量名
			return resolve(vscode.window.showInputBox({
				prompt: '请输入对应的 I18N 变量，按 <回车> 启动替换',
				value: 'I18N.',
				validateInput(input) {
					if (!input.startsWith('I18N.')) {
						return '请确保变量名以 `I18N.` 开头';
					}

					if (input.length < 5) {
						return '请输入变量名';
					}
				}
			}));
		})
		.then((val: string) => {
			// 没有输入变量名
			if (!val) {
				return;
			}

			const finalArgs = Array.isArray(args.targets) ? args.targets : [args.targets];

			finalArgs.forEach((arg: TargetStr) => {
				const edit = new vscode.WorkspaceEdit();
				const { document } = vscode.window.activeTextEditor;

				// 若是字符串，删掉两侧的引号
				if (arg.isString) {

					// 如果引号左侧是 等号，则可能是 jsx 的 props，此时要替换成 {
					const prevTextRange = new vscode.Range(arg.range.start.translate(0, -2), arg.range.start.translate(0, -1));
					const prevText = document.getText(prevTextRange);

					let finalReplaceVal = val;
					if (prevText === '=') {
						finalReplaceVal = '{' + val + '}';
					}

					edit.replace(document.uri, arg.range.with({
						start: arg.range.start.translate(0, -1),
						end: arg.range.end.translate(0, 1),
					}), finalReplaceVal);
				} else {
					edit.replace(document.uri, arg.range, '{' + val + '}');
				}

				vscode.workspace.applyEdit(edit);
			});

			vscode.window.showInformationMessage(`成功替换 ${finalArgs.length} 处文案`);
		})
	});

	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	vscode.workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	var timeout = null;
	function triggerUpdateDecorations() {
		if (vscode.workspace.getConfiguration('vscode-i18n-linter').get('markStringLiterals') !== true) {
			return;
		}

		if (timeout) {
			clearTimeout(timeout);
		}
		timeout = setTimeout(updateDecorations, 500);
	}

	// 扫描文档，通过正则匹配找出所有中文文案
	interface TargetStr {
		text: string;
		range: vscode.Range;
		isString: boolean;
	}
	var targetStrs: TargetStr[] = [];
	// 配置提示框样式
	const chineseCharDecoration = vscode.window.createTextEditorDecorationType({
		borderWidth: '1px',
		borderStyle: 'dotted',
		overviewRulerColor: '#7499c7',
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		light: {
			borderColor: '#7499c7'
		},
		dark: {
			borderColor: '#7499c7'
		}
	});
	function updateDecorations() {
		if (!activeEditor) {
			return;
		}

		// 清空上一次的保存结果
		targetStrs = [];

		const possibleOccurenceEx = /(["'`])\s*(.+?)\s*\1|>\s*([^<{\)]+?)\s*[<{]/g;
		const hasCJKEx = /[\u4E00-\u9FCC\u3400-\u4DB5\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uff1a\uff0c\uFA27-\uFA29]|[\ud840-\ud868][\udc00-\udfff]|\ud869[\udc00-\uded6\udf00-\udfff]|[\ud86a-\ud86c][\udc00-\udfff]|\ud86d[\udc00-\udf34\udf40-\udfff]|\ud86e[\udc00-\udc1d]|[\uff01-\uff5e\u3000-\u3009\u2026]/;
		const containsCommentEx = /\/\*\*/;
		const text = activeEditor.document.getText();
		const chineseChars: vscode.DecorationOptions[] = [];

		let match;
		while (match = possibleOccurenceEx.exec(text)) {
			let isString = true;
			if (match[3]) {
				isString = false;
			}

			const m = match[3] || match[2];
			if (!m.match(hasCJKEx) || m.match(containsCommentEx)) {
				continue;
			}

			const leftTrim = match[0].replace(/^[>\s]*/m, '');
			const rightTrim = match[0].replace(/[<\{\s]*$/m, '');
			const leftOffset = match[0].length - leftTrim.length;
			const rightOffset = match[0].length - rightTrim.length;
			const finalMatch = m;

			const startPos = activeEditor.document.positionAt(match.index + leftOffset + (isString ? 1 : 0));
			const endPos = activeEditor.document.positionAt(match.index + leftOffset + finalMatch.length + (isString ? 1 : 0));
			const range = new vscode.Range(startPos, endPos);
			const decoration = { range, hoverMessage: '检测到中文文案： **' + finalMatch + '**' };

			targetStrs.push({
				text: finalMatch,
				range,
				isString,
			});

    	chineseChars.push(decoration);
    }
		activeEditor.setDecorations(chineseCharDecoration, chineseChars);
	}
}

function getSuggestLangObj() {
	const paths = globby.sync(I18N_GLOB);
	const langObj = paths.reduce((prev, curr) => {
		const filename = curr.split('/').pop().replace(/\.tsx?$/, '');
		if (filename.replace(/\.tsx?/, '') === 'index') {
			return prev;
		}
		const fileContent = fs.readFileSync(curr, { encoding: 'utf8' });
		const obj = fileContent.match(/export\s*default\s*({[\s\S]+);?$/)[1];
		let jsObj = {};
		try {
			jsObj = JSON.parse(obj.replace(/\s*;\s*$/, ''));
		}
		catch (err) {
			console.error(err);
		}
		return {
			...prev,
			[filename]: jsObj,
		};
	}, {});
	const finalLangObj = flatten(langObj) as any;
	return finalLangObj;
}

// this method is called when your extension is deactivated
export function deactivate() {
}
