'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import { flatten } from './utils';
import * as globby from 'globby';
import * as _ from 'lodash';

const LANG_PREFIX = `${vscode.workspace.rootPath}/langs/zh_CN/`;
const I18N_GLOB = `${LANG_PREFIX}*.ts`;

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
					if (finalLangObj[key] === text) {
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

			const currentFilename = activeEditor.document.fileName;
			const suggestPageRegex = /\/pages\/\w+\/([^\/]+)\/([^\/\.]+)/;
			const suggestComponentRegex = /\/components\/(\w+)\/.*?\.tsx?/;

			let suggestion = [];
			if (currentFilename.includes('/pages/')) {
				suggestion = currentFilename.match(suggestPageRegex);
			} else {
				suggestion = currentFilename.match(suggestComponentRegex);
			}

			suggestion.shift();

			// 否则要求用户输入变量名
			return resolve(vscode.window.showInputBox({
				prompt: '请输入变量名，格式 `I18N.[page].[key]`，按 <回车> 启动替换',
				value: `I18N.${suggestion.length ? suggestion.join('.') + '.' : ''}`,
				validateInput(input) {
					if (!input.match(/^I18N\.\w+\.\w+/)) {
						return '变量名格式 `I18N.[page].[key]`，如 `I18N.dim.new`，[key] 中可包含更多 `.`';
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
			finalArgs.reduce((prev: Promise<any>, curr: TargetStr, index: number) => {
				return prev.then(() => {
					const isEditCommon = val.startsWith('I18N.common.');
					return replaceAndUpdate(curr, val, !isEditCommon && index === 0 ? !args.varName : false);
				});
			}, Promise.resolve())
			.then(() => {
				vscode.window.showInformationMessage(`成功替换 ${finalArgs.length} 处文案`);
			});
		});
	});

	// 使用 cmd + shift + p 执行的公共文案替换
	vscode.commands.registerCommand('vscode-i18n-linter.replaceCommon', () => {
		const commandKeys = Object.keys(finalLangObj).filter(k => k.includes('common.'));
		if (targetStrs.length === 0 || commandKeys.length === 0) {
			vscode.window.showInformationMessage('没有找到可替换的公共文案');
			return;
		}

		const replaceableStrs = targetStrs.reduce((prev, curr) => {
			const key = findMatchKey(finalLangObj, curr.text);
			if (key && key.startsWith('common.')) {
				return prev.concat({
					target: curr,
					key,
				});
			}

			return prev;
		}, []);

		if (replaceableStrs.length === 0) {
			vscode.window.showInformationMessage('没有找到可替换的公共文案');
			return;
		}

		vscode.window.showInformationMessage(`共找到 ${replaceableStrs.length} 处可自动替换的文案，是否替换？`, { modal: true }, 'Yes')
		.then(action => {
			if (action === 'Yes') {
				replaceableStrs.reduce((prev: Promise<any>, obj) => {
					return prev.then(() => {
						return replaceAndUpdate(obj.target, `I18N.${obj.key}`, false);
					});
				}, Promise.resolve())
				.then(() => {
					vscode.window.showInformationMessage('替换完成');
				})
				.catch(e => {
					vscode.window.showErrorMessage(e.message);
				});
			}
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

	/**
	 * 更新文件
	 * @param arg  目标字符串对象
	 * @param val  目标 key
	 * @param validateDuplicate 是否校验文件中已经存在要写入的 key
	 */
	function replaceAndUpdate(arg: TargetStr, val: string, validateDuplicate: boolean): Thenable<any> {
		const edit = new vscode.WorkspaceEdit();
		const { document } = vscode.window.activeTextEditor;

		let finalReplaceText = arg.text;

		// 若是字符串，删掉两侧的引号
		if (arg.isString) {
			// 如果引号左侧是 等号，则可能是 jsx 的 props，此时要替换成 {
			const prevTextRange = new vscode.Range(arg.range.start.translate(0, -2), arg.range.start);
			const [last2Char, last1Char] = document.getText(prevTextRange).split('');
			let finalReplaceVal = val;
			if (last2Char === '=') {
				finalReplaceVal = '{' + val + '}';
			}

			// 若是模板字符串，看看其中是否包含变量
			if (last1Char === '`') {
				const varInStr = arg.text.match(/(\$\{[^\}]+?\})/g);
				if (varInStr) {
					const kvPair = varInStr
						.map((str, index) => {
							return `val${index+1}: ${str.replace(/^\${([^\}]+)\}$/, '$1')}`;
						});
					finalReplaceVal = `I18N.get('${val.replace(/^I18N\./, '')}', { ${kvPair.join(',\n')} })`;

					varInStr.forEach((str, index) => {
						finalReplaceText = finalReplaceText.replace(str, `{val${index+1}}`);
					});
				}
			}

			edit.replace(document.uri, arg.range.with({
				start: arg.range.start.translate(0, -1),
				end: arg.range.end.translate(0, 1),
			}), finalReplaceVal);
		}
		else {
			edit.replace(document.uri, arg.range, '{' + val + '}');
		}

		try {
			// 更新语言文件
			updateLangFiles(val, finalReplaceText, validateDuplicate);
			// 若更新成功再替换代码
			return vscode.workspace.applyEdit(edit);
		}
		catch (e) {
			return Promise.reject(e.message);
		}
	}

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
		let jsObj = parseLangFileToObject(fileContent);

		if (Object.keys(jsObj).length === 0) {
			vscode.window.showWarningMessage(`\`${curr}\` 解析失败，该文件包含的文案无法自动补全`);
		}

		return {
			...prev,
			[filename]: jsObj,
		};
	}, {});
	const finalLangObj = flatten(langObj) as any;
	return finalLangObj;
}

function parseLangFileToObject(fileContent: string) {
	const obj = fileContent.match(/export\s*default\s*({[\s\S]+);?$/)[1];
	let jsObj = {};
	try {
		jsObj = JSON.parse(obj.replace(/\s*;\s*$/, ''));
	}
	catch (err) {
		console.log(obj)
		console.error(err);
	}
	return jsObj;
}

function updateLangFiles(lang: string, text: string, validateDuplicate: boolean) {
	if (!lang.startsWith('I18N.')) {
		return;
	}

	const [, filename, ...restPath ] = lang.split('.');
	const fullKey = restPath.join('.');
	const targetFilename = `${LANG_PREFIX}${filename}.ts`;

	if (!fs.existsSync(targetFilename)) {
		fs.writeFileSync(targetFilename, generateNewLangFile(fullKey, text));
		addImportToMainLangFile(filename);
		vscode.window.showInformationMessage(`成功新建语言文件 ${targetFilename}`);
	} else {
		const mainContent = fs.readFileSync(targetFilename, 'utf8');
		const obj = parseLangFileToObject(mainContent);

		if (Object.keys(obj).length === 0) {
			vscode.window.showWarningMessage(`${filename} 解析失败，该文件包含的文案无法自动补全`);
		}

		if (validateDuplicate && _.get(obj, fullKey) !== undefined) {
			vscode.window.showErrorMessage(`${targetFilename} 中已存在 key 为 \`${fullKey}\` 的翻译，请重新命名变量`);
			throw new Error('duplicate');
		}

		_.set(obj, fullKey, text);
		fs.writeFileSync(targetFilename, `export default ${JSON.stringify(obj, null, 2)}`);
	}
}

function generateNewLangFile(key: string, value: string) {
	return `export default {
	"${key}": "${value}"
}`;
}

function addImportToMainLangFile(newFilename: string) {
	let mainContent = fs.readFileSync(`${LANG_PREFIX}index.ts`, 'utf8');
	mainContent = mainContent.replace(/^(\s*import.*?;)$/m, `$1\nimport ${newFilename} from './${newFilename}';`);
	mainContent = mainContent.replace(/(}\);\s)/, `  ${newFilename},\n$1`);
	fs.writeFileSync(`${LANG_PREFIX}index.ts`, mainContent);
}

function findMatchKey(langObj, text) {
	for (const key in langObj) {
		if (langObj[key] === text) {
			return key;
		}
	}

	return null;
}

// this method is called when your extension is deactivated
export function deactivate() {
}
