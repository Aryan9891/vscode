/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExternalUriOpenerPriority } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ViewColumn } from '../../../../../platform/editor/common/editor.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { ExternalUriOpenerService, IExternalOpenerProvider, IExternalUriOpener } from '../../common/externalUriOpenerService.js';


class MockQuickInputService implements Partial<IQuickInputService> {

	constructor(
		private readonly pickIndex: number
	) { }

	public pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }, token?: CancellationToken): Promise<T[]>;
	public pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }, token?: CancellationToken): Promise<T>;
	public async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: Omit<IPickOptions<T>, 'canPickMany'>, token?: CancellationToken): Promise<T | undefined> {
		const resolvedPicks = await picks;
		const item = resolvedPicks[this.pickIndex];
		if (item.type === 'separator') {
			return undefined;
		}
		return item;
	}

}

suite('ExternalUriOpenerService', () => {
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;

	setup(() => {
		disposables = new DisposableStore();
		instantiationService = disposables.add(new TestInstantiationService());

		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IOpenerService, {
			registerExternalOpener: () => { return Disposable.None; }
		});
	});

	teardown(() => {
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Should not open if there are no openers', async () => {
		const externalUriOpenerService = disposables.add(instantiationService.createInstance(ExternalUriOpenerService));

		externalUriOpenerService.registerExternalOpenerProvider(new class implements IExternalOpenerProvider {
			async *getOpeners(_targetUri: URI): AsyncGenerator<IExternalUriOpener> {
				// noop
			}
		});

		const uri = URI.parse('http://contoso.com');
		const didOpen = await externalUriOpenerService.openExternal(uri.toString(), { sourceUri: uri }, CancellationToken.None);
		assert.strictEqual(didOpen, false);
	});

	test('Should prompt if there is at least one enabled opener', async () => {
		instantiationService.stub(IQuickInputService, new MockQuickInputService(0));

		const externalUriOpenerService = disposables.add(instantiationService.createInstance(ExternalUriOpenerService));

		let openedWithEnabled = false;
		let viewColumn: ViewColumn | undefined;
		externalUriOpenerService.registerExternalOpenerProvider(new class implements IExternalOpenerProvider {
			async *getOpeners(_targetUri: URI): AsyncGenerator<IExternalUriOpener> {
				yield {
					id: 'disabled-id',
					label: 'disabled',
					canOpen: async () => ExternalUriOpenerPriority.None,
					openExternalUri: async () => true,
				};
				yield {
					id: 'enabled-id',
					label: 'enabled',
					canOpen: async () => ExternalUriOpenerPriority.Default,
					openExternalUri: async (_uri, context) => {
						openedWithEnabled = true;
						viewColumn = context.viewColumn;
						return true;
					}
				};
			}
		});

		const uri = URI.parse('http://contoso.com');
		const didOpen = await externalUriOpenerService.openExternal(uri.toString(), { sourceUri: uri, viewColumn: ViewColumn.Beside }, CancellationToken.None);
		assert.deepStrictEqual({ didOpen, openedWithEnabled, viewColumn }, { didOpen: true, openedWithEnabled: true, viewColumn: ViewColumn.Beside });
	});

	test('Should automatically pick single preferred opener without prompt', async () => {
		const externalUriOpenerService = disposables.add(instantiationService.createInstance(ExternalUriOpenerService));

		let openedWithPreferred = false;
		externalUriOpenerService.registerExternalOpenerProvider(new class implements IExternalOpenerProvider {
			async *getOpeners(_targetUri: URI): AsyncGenerator<IExternalUriOpener> {
				yield {
					id: 'other-id',
					label: 'other',
					canOpen: async () => ExternalUriOpenerPriority.Default,
					openExternalUri: async () => {
						return true;
					}
				};
				yield {
					id: 'preferred-id',
					label: 'preferred',
					canOpen: async () => ExternalUriOpenerPriority.Preferred,
					openExternalUri: async () => {
						openedWithPreferred = true;
						return true;
					}
				};
			}
		});

		const uri = URI.parse('http://contoso.com');
		const didOpen = await externalUriOpenerService.openExternal(uri.toString(), { sourceUri: uri }, CancellationToken.None);
		assert.strictEqual(didOpen, true);
		assert.strictEqual(openedWithPreferred, true);
	});

	test('Should prefer requested and configured openers, and pass the link as written', async () => {
		const configurationService = new TestConfigurationService();
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(IQuickInputService, new MockQuickInputService(0));
		const href = 'http://contoso.com/search?q=a%26b';

		const open = async (priorities: Record<string, ExternalUriOpenerPriority>, preferredOpenerId?: string) => {
			const opened: string[] = [];
			const externalUriOpenerService = disposables.add(instantiationService.createInstance(ExternalUriOpenerService));
			disposables.add(externalUriOpenerService.registerExternalOpenerProvider(new class implements IExternalOpenerProvider {
				async *getOpeners(_targetUri: URI): AsyncGenerator<IExternalUriOpener> {
					for (const [id, priority] of Object.entries(priorities)) {
						yield { id, label: id, canOpen: async () => priority, openExternalUri: async openedHref => { opened.push(`${id}:${openedHref}`); return true; } };
					}
				}
			}));
			const didOpen = await externalUriOpenerService.openExternal(href, { sourceUri: URI.parse(href), preferredOpenerId }, CancellationToken.None);
			return { didOpen, opened };
		};

		const results = {
			onlyOptional: await open({ a: ExternalUriOpenerPriority.Option, b: ExternalUriOpenerPriority.Option }),
			singleDefault: await open({ a: ExternalUriOpenerPriority.None, b: ExternalUriOpenerPriority.Default }),
			defaultAndOptionalPromptsBestFirst: await open({ a: ExternalUriOpenerPriority.Option, b: ExternalUriOpenerPriority.Default }),
			firstOfSeveralPreferred: await open({ a: ExternalUriOpenerPriority.Preferred, b: ExternalUriOpenerPriority.Preferred }),
			requestedDisabled: await open({ a: ExternalUriOpenerPriority.Preferred, b: ExternalUriOpenerPriority.None }, 'b'),
			requestedDefault: await open({ a: ExternalUriOpenerPriority.Preferred }, 'default'),
			requestedUnknown: await open({ a: ExternalUriOpenerPriority.Preferred }, 'unknown'),
		};
		await configurationService.setUserConfiguration('workbench.externalUriOpeners', { 'contoso.com': 'b' });
		const configured = await open({ a: ExternalUriOpenerPriority.Preferred, b: ExternalUriOpenerPriority.None });

		assert.deepStrictEqual({ ...results, configured }, {
			onlyOptional: { didOpen: false, opened: [] },
			singleDefault: { didOpen: true, opened: [`b:${href}`] },
			defaultAndOptionalPromptsBestFirst: { didOpen: true, opened: [`b:${href}`] },
			firstOfSeveralPreferred: { didOpen: true, opened: [`a:${href}`] },
			requestedDisabled: { didOpen: true, opened: [`b:${href}`] },
			requestedDefault: { didOpen: false, opened: [] },
			requestedUnknown: { didOpen: true, opened: [`a:${href}`] },
			configured: { didOpen: true, opened: [`b:${href}`] },
		});
	});

	test('Should get the requested or best opener, including optional ones', async () => {
		const externalUriOpenerService = disposables.add(instantiationService.createInstance(ExternalUriOpenerService));
		disposables.add(externalUriOpenerService.registerExternalOpenerProvider(new class implements IExternalOpenerProvider {
			async *getOpeners(_targetUri: URI): AsyncGenerator<IExternalUriOpener> {
				yield { id: 'optional', label: 'optional', canOpen: async () => ExternalUriOpenerPriority.Option, openExternalUri: async () => true };
				yield { id: 'enabled', label: 'enabled', canOpen: async () => ExternalUriOpenerPriority.Default, openExternalUri: async () => true };
			}
		}));

		const uri = URI.parse('http://contoso.com');
		const opener = await externalUriOpenerService.getOpener(uri, { sourceUri: uri }, CancellationToken.None);
		assert.strictEqual(opener?.id, 'enabled');
	});
});
