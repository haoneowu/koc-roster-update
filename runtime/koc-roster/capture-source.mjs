import {DATA_DIR} from '../shared/config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStorageState, restoreSession} from '../local-session.mjs';
import {
  appendCheckpointPage, assertResumableCheckpoint, createCheckpoint, DEFAULT_STATE_DIR,
  finishCheckpoint, readPrivateJson, writePrivateJson,
} from './checkpoint.mjs';
import {classifyRankedRows, pageFingerprint, parseRankingRow, ROSTER_SCOPE_KEY, ROSTER_SCOPE_LABEL, verifyDescendingByMetric} from './roster-domain.mjs';

const ORIGIN = 'https://www.chanmama.com';
const RANKING_URL = `${ORIGIN}/bloggerRank/`; // Previously reached through the visible "抖音达人数据库" menu link.
const SCOPE_KEY = ROSTER_SCOPE_KEY;
const SCOPE_LABEL = ROSTER_SCOPE_LABEL;
const sessionFile = path.join(DATA_DIR,'auth','www.chanmama.com.json');

export function sourceBrowserLaunchOptions(environment=process.env){
 const executablePath=String(environment.CHROME_PATH||'').trim();
 return executablePath?{executablePath,headless:true}:{channel:'chrome',headless:true};
}
export function launchSourceBrowser(browserType=chromium,environment=process.env){
 return browserType.launch(sourceBrowserLaunchOptions(environment));
}

function parseArgs(argv) {
  const result = {target: 500, maxPages: 100, stateDir: DEFAULT_STATE_DIR, resumeBatchId: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') result.target = Number(argv[++i]);
    else if (arg === '--max-pages') result.maxPages = Number(argv[++i]);
    else if (arg === '--state-dir') result.stateDir = path.resolve(argv[++i]);
    else if (arg === '--resume') result.resumeBatchId = String(argv[++i] || '');
    else throw new Error('KOC_SOURCE_ARGUMENT_UNSUPPORTED');
  }
  if (!Number.isInteger(result.target) || result.target < 1 || result.target > 500) throw new Error('KOC_SOURCE_TARGET_INVALID');
  if (!Number.isInteger(result.maxPages) || result.maxPages < 1 || result.maxPages > 100) throw new Error('KOC_SOURCE_MAX_PAGES_INVALID');
  return result;
}

function makeBatchId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function countVisible(list) {
  return list.evaluateAll(items => items.filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden').length);
}

async function waitForRankingTable(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readLivePage(page).catch(() => null);
    if (last?.loginRequired) throw new Error('KOC_SOURCE_LOGIN_REQUIRED');
    if (last?.securityChallenge) throw new Error('KOC_SOURCE_SECURITY_CHALLENGE');
    if (last?.menuDenied) throw new Error('KOC_SOURCE_MENU_DENIED');
    if (last?.rankingTableCount === 1 && last?.headers?.includes('视频销售额') && last.rows.length) return last;
    await page.waitForTimeout(300);
  }
  const error = new Error('KOC_SOURCE_RANKING_TABLE_NOT_READY');
  error.safeState = last ? {origin:last.origin,path:last.path,title:last.title,loginRequired:last.loginRequired,
    securityChallenge:last.securityChallenge,menuDenied:last.menuDenied,statusLines:last.statusLines} : null;
  throw error;
}

export async function readLivePage(page) {
  return page.evaluate(() => {
    const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const bodyText = document.body?.innerText || '';
    const normalizedLabel = element => (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const readSelectedControl = element => {
      const label = normalizedLabel(element);
      const className = typeof element.className === 'string' ? element.className : '';
      const selected = element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-pressed') === 'true' ||
        element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-current') === 'page' ||
        /active|selected|checked/.test(className);
      return {label, selected, className};
    };
      const tables = [...document.querySelectorAll('table,[role="table"]')].filter(visible).map(table => {
        const rowElements = [...table.querySelectorAll('tr,[role="row"]')].filter(visible);
        const cellElements = row => [...row.querySelectorAll(':scope > th,:scope > td,:scope > [role="columnheader"],:scope > [role="cell"],:scope > [role="gridcell"]')].filter(visible);
      const readCell = (cell, index, isHeaderRow) => {
        if (index === 0) {
          if (isHeaderRow) return (cell.innerText || cell.getAttribute('aria-label') || '').trim();
          const nameLinks = [...cell.querySelectorAll('a.link-hover')].filter(visible);
            if (nameLinks.length !== 1) return '';
            const creatorName = (nameLinks[0].innerText || '').trim();
            const idNodes = [...cell.querySelectorAll('.ellipsis-1.text-align-left.c999.fs12.pr5.mt5')].filter(visible);
            const creatorId = idNodes.length === 1 ? (idNodes[0].innerText || '').trim() : '';
            return creatorId ? `${creatorName}\n${creatorId}` : creatorName;
          }
          return (cell.innerText || cell.getAttribute('aria-label') || '').trim();
        };
      const textRows = rowElements.map(element => {
        const cells = cellElements(element);
        const rawCells = cells.map(cell => (cell.innerText || cell.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '));
        const isHeaderRow = rawCells.includes('达人') && rawCells.includes('视频销售额');
        return {element, cells:cells.map((cell, index) => readCell(cell, index, isHeaderRow))};
      });
      const headerIndex = textRows.findIndex(row => row.cells.some(cell => /视频销售额/.test(cell)));
      if (headerIndex < 0) return null;
      const headers = textRows[headerIndex].cells.map(value => value.replace(/\s+/g, ' ').trim());
      const rows = textRows.slice(headerIndex + 1).map(({element, cells}) => {
        if (!cells.length) return null;
        const profileUrls = [...new Set([...element.querySelectorAll('a[href]')].filter(visible).map(anchor => {
          try {
            const url = new URL(anchor.href, location.href);
            return url.origin === location.origin && /^\/bloggerRank\/[^/]+\.html$/.test(url.pathname) ? url.href : '';
          } catch { return ''; }
        }).filter(Boolean))];
        return {cells, sourceProfileUrl: profileUrls.length === 1 ? profileUrls[0] : ''};
      }).filter(row => row && row.cells.length);
      if (!headers.includes('达人') || !headers.includes('视频销售额') || !rows.length) return null;
      const tabsContainer = table.closest('.el-tabs');
      const elTabNavs = tabsContainer ? [...tabsContainer.querySelectorAll('.el-tabs__nav')].filter(visible) : [];
      const tabPanelOwner = table.closest('[role="tabpanel"]')?.parentElement;
      const roleTabLists = !tabsContainer && tabPanelOwner ? [...tabPanelOwner.querySelectorAll('[role="tablist"]')].filter(visible) : [];
      // Current ranking page uses a plain .tab-box with .item controls rather
      // than Element tabs or ARIA tablists. Keep this fallback scoped to the
      // visible search result that owns the table.
      const searchResult = table.closest('.search-result');
      const creatorTabBoxes = !elTabNavs.length && !roleTabLists.length && searchResult
        ? [...searchResult.querySelectorAll('.tab-box')].filter(root => visible(root) &&
          [...root.querySelectorAll('.item')].filter(visible).some(item => normalizedLabel(item) === '视频达人'))
        : [];
      const tabRoots = elTabNavs.length ? elTabNavs : roleTabLists.length ? roleTabLists : creatorTabBoxes;
      const boardControls = tabRoots.length === 1
        ? [...tabRoots[0].querySelectorAll('[role="tab"],.el-tabs__item,.item')].filter(visible).map(readSelectedControl)
        : [];
      const matchingVideoTabs = boardControls.filter(item => item.label === '视频达人');
      const selectedBoardLabels = matchingVideoTabs.length === 1 && matchingVideoTabs[0].selected ? ['视频达人'] : [];
      const headerState = [...table.querySelectorAll('th,[role="columnheader"]')].filter(visible).map(cell => ({
        label: (cell.innerText || '').trim().replace(/\s+/g, ' '),
        ariaSort: cell.getAttribute('aria-sort') || '',
        className: typeof cell.className === 'string' ? cell.className : '',
        sortHint: [...cell.querySelectorAll('[aria-label],svg,title,button,[role="button"]')].map(el => ({
          label: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '',
          className: typeof el.className === 'string' ? el.className : '',
        })).filter(item => item.label || /sort|order|arrow/i.test(item.className)).slice(0, 8),
      }));
      const salesHeader = headerState.find(item => item.label === '视频销售额');
      const salesSortText = [salesHeader?.ariaSort, salesHeader?.className,
        ...(salesHeader?.sortHint || []).flatMap(item => [item.label, item.className])].join(' ').toLowerCase();
      const videoSalesDirection = /descending|\bdesc\b|降序/.test(salesSortText) ? 'desc' :
        /ascending|\basc\b|升序/.test(salesSortText) ? 'asc' : '';
      return {headers, rows, headerState, videoSalesDirection, selectedBoardLabels,
        boardTabGroupCount:tabRoots.length, videoBoardTabCount:matchingVideoTabs.length};
    }).filter(Boolean);
    const rankingTable = tables.length === 1 ? tables[0] : null;

    const pagination = [...document.querySelectorAll('.el-pagination')].find(visible);
    const pageItems = pagination ? [...pagination.querySelectorAll('li.number,button.number,[class~="number"]')].filter(visible).map(item => ({
      label: (item.innerText || '').trim(), className: typeof item.className === 'string' ? item.className : '',
    })).filter(item => /^\d+$/.test(item.label)) : [];
    const activePage = pageItems.find(item => /is-active|active/.test(item.className))?.label || '';
    const totalPages = pageItems.length ? Number(pageItems.at(-1).label) : null;
    const nextButton = pagination?.querySelector('button.btn-next');
    const categoryButtons = [...document.querySelectorAll('button')].filter(visible).filter(button => (button.innerText || '').trim() === '萌宠');
    const categoryButton = categoryButtons.length === 1 ? categoryButtons[0] : null;
    const categoryMenuRoots = [...document.querySelectorAll('[role="menu"],[role="listbox"]')].filter(visible);
    const selectedCategoryControls = categoryMenuRoots.length === 1
      ? [...categoryMenuRoots[0].querySelectorAll('[role="option"],[role="menuitem"]')]
        .filter(visible).map(readSelectedControl).filter(item => item.label)
      : [];
    const categoryBreadcrumbs = [...document.querySelectorAll('.el-breadcrumb,[aria-label*="breadcrumb" i]')]
      .filter(visible).map(normalizedLabel).filter(Boolean);
    const selectedCategoryTags = [...document.querySelectorAll('.selected-item-block')]
      .filter(visible).map(normalizedLabel)
      .filter(label => /达人分类\s*[:：]\s*萌宠\s*[-－‐‑–—>›→]\s*宠物猫/.test(label));
    const selectedPetCatControls = selectedCategoryControls.filter(item => item.label === '宠物猫' && item.selected);
    const petCatBreadcrumbs = categoryBreadcrumbs.filter(label => /^萌宠\s*(?:>|\/|→|›)\s*宠物猫$/.test(label));
    const categoryLeafSelected = categoryMenuRoots.length === 1 && selectedPetCatControls.length === 1 && petCatBreadcrumbs.length <= 1 ||
      selectedPetCatControls.length === 0 && petCatBreadcrumbs.length === 1 && categoryMenuRoots.length <= 1 ||
      selectedCategoryTags.length === 1;
    const selectedBoardLabels = rankingTable?.selectedBoardLabels || [];
    const subjectTypeHeaders = (rankingTable?.headers || []).filter(header => /主体(?:类型|性质)?|账号类型|达人类型|账号性质/.test(header));
    const businessSignalHeaders = (rankingTable?.headers || []).filter(header => /店铺|认证|品牌|商家/.test(header));
    const tradeInputs = [...document.querySelectorAll('input[type="checkbox"]')]
      .filter(input => [...(input.labels || [])].some(label => /近30天有带货/.test(label.innerText || '')));
    const hasTradeInput = tradeInputs.length === 1 ? tradeInputs[0] : null;
    const timeEvidence = [...new Set(bodyText.split(/\n+/).map(line => line.trim().replace(/\s+/g, ' ')))].filter(line => /所选类目下达人近30天数据|近30天有带货/.test(line)).slice(0, 5);
    const statusLines = [...new Set(bodyText.split(/\n+/).map(line=>line.trim().replace(/\s+/g,' ')))]
      .filter(line=>line.length<=120&&/加载|暂无|无数据|错误|异常|登录|权限|验证|请求|榜单|筛选/.test(line)).slice(0,20);
    const loginRequired = /用户未登录|登录已过期|登录信息已失效|请先登录/.test(bodyText);
    const securityChallenge = /安全验证|完成验证|滑块验证|验证码/.test(bodyText);
    const menuDenied = bodyText.includes('当前账号没有菜单权限');
    return {
      origin: location.origin, path: location.pathname, title: document.title,
      rankingTableCount:tables.length,
      headers: rankingTable?.headers || [], rows: rankingTable?.rows || [], headerState: rankingTable?.headerState || [],
      videoSalesDirection:rankingTable?.videoSalesDirection || '',
      currentPage: Number(activePage) || null, totalPages,
      pageNumbers: pageItems, nextEnabled: !!nextButton && !nextButton.disabled && !nextButton.hasAttribute('disabled'),
      categoryButtonCount:categoryButtons.length,
      categoryMenuCount:categoryMenuRoots.length,
      selectedCategoryTags,
      categoryButton: categoryButton ? {label:(categoryButton.innerText||'').trim(),selected:categoryButton.getAttribute('aria-pressed')==='true'||categoryButton.getAttribute('aria-selected')==='true'||/active|selected/.test(typeof categoryButton.className==='string'?categoryButton.className:''),className:typeof categoryButton.className==='string'?categoryButton.className:''} : null,
      categoryLeafSelected, categoryBreadcrumbs, selectedCategoryControls, selectedPetCatControls, petCatBreadcrumbs,
      selectedBoardLabels, subjectTypeHeaders, businessSignalHeaders,
      boardTabGroupCount:rankingTable?.boardTabGroupCount || 0, videoBoardTabCount:rankingTable?.videoBoardTabCount || 0,
      near30HasTrade: hasTradeInput ? hasTradeInput.checked === true : null,
      near30HasTradeControlCount:tradeInputs.length,
      timeEvidence,statusLines,
      loginRequired, securityChallenge, menuDenied,
    };
  });
}

export function normalizePageState(state, pageNumber, pageSize) {
  if (!state.headers.includes('达人') || !state.headers.includes('视频销售额')) throw new Error('KOC_SOURCE_EXPECTED_HEADERS_MISSING');
  const offset = (pageNumber - 1) * pageSize;
  return state.rows.map((row, index) => parseRankingRow({headers: state.headers, cells: row.cells,
    sourceRank: offset + index + 1, sourceProfileUrl: row.sourceProfileUrl}));
}

async function selectPetCat(page) {
  const categoryButtons = page.locator('button:visible').filter({hasText:/^\s*萌宠\s*$/});
  const categoryCount = await categoryButtons.count();
  if (categoryCount !== 1 || !(await categoryButtons.isEnabled())) throw new Error('KOC_SOURCE_CATEGORY_CONTROL_NOT_UNIQUE');
  await categoryButtons.click({timeout: 10000});

  const categoryMenus = page.locator('[role="menu"]:visible,[role="listbox"]:visible');
  if (await categoryMenus.count() !== 1) throw new Error('KOC_SOURCE_CATEGORY_MENU_NOT_UNIQUE');
  const options = categoryMenus.locator('[role="menuitem"],[role="option"]').filter({hasText:/^\s*宠物猫\s*$/});
  const visibleOptions = await countVisible(options);
  if (visibleOptions !== 1) throw new Error('KOC_SOURCE_PET_CAT_OPTION_NOT_UNIQUE');
  const expectedSearch = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'api-service.chanmama.com' && url.pathname === '/v5/home/author/search' &&
        url.searchParams.get('author_type') === '2' && url.searchParams.get('star_category') === '萌宠' &&
        url.searchParams.get('star_sub_category') === '宠物猫' &&
        url.searchParams.get('sort') === 'aweme_total_amount_30' && url.searchParams.get('order_by') === 'desc';
    } catch { return false; }
  }, {timeout:15000});
  await options.filter({visible:true}).click({timeout: 10000});

  let searchResponse;
  try { searchResponse = await expectedSearch; }
  catch { throw new Error('KOC_SOURCE_SCOPED_SEARCH_RESPONSE_NOT_RECEIVED'); }
  let searchPayload;
  try { searchPayload = await searchResponse.json(); }
  catch { throw new Error('KOC_SOURCE_SCOPED_SEARCH_RESPONSE_NOT_JSON'); }
  const searchData = searchPayload?.data ?? {};
  const searchRows = Array.isArray(searchData.list) ? searchData.list : [];
  const searchUrl = new URL(searchResponse.url());
  const searchEvidence = {
    httpStatus:searchResponse.status(), errCode:searchPayload?.errCode ?? null,
    listCount:searchRows.length, totalCount:searchData.page_info?.totalCount ?? null,
    authorType:searchUrl.searchParams.get('author_type'),
    category:searchUrl.searchParams.get('star_category'), subCategory:searchUrl.searchParams.get('star_sub_category'),
    sort:searchUrl.searchParams.get('sort'), orderBy:searchUrl.searchParams.get('order_by'),
  };
  if (!searchResponse.ok() || searchEvidence.errCode !== 0) {
    const error = new Error('KOC_SOURCE_SCOPED_SEARCH_BUSINESS_ERROR');
    error.safeState = searchEvidence;
    throw error;
  }
  if (!searchRows.length) {
    const error = new Error('KOC_SOURCE_SCOPED_SEARCH_RETURNED_NO_ROWS');
    error.safeState = searchEvidence;
    throw error;
  }
  await page.waitForFunction(expectedRowCount => {
    const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const table = [...document.querySelectorAll('table,[role="table"]')].find(el => visible(el) &&
      [...el.querySelectorAll('tr,[role="row"]')].some(row => visible(row) && /视频销售额/.test(row.innerText || '')));
    if (!table) return false;
    const tag = [...document.querySelectorAll('.selected-item-block')].find(el => visible(el) &&
      /达人分类\s*[:：]\s*萌宠\s*[-－‐‑–—>›→]\s*宠物猫/.test((el.innerText || '').trim().replace(/\s+/g, ' ')));
    if (!tag) return false;
    const rows = [...table.querySelectorAll('tr,[role="row"]')].filter(visible);
    const headerIndex = rows.findIndex(row => /视频销售额/.test(row.innerText || ''));
    return headerIndex >= 0 && rows.length - headerIndex - 1 === expectedRowCount;
  }, searchRows.length, {timeout:12000}).catch(() => {
    const error = new Error('KOC_SOURCE_SCOPED_RESULTS_NOT_RENDERED');
    error.safeState = searchEvidence;
    throw error;
  });
  await page.waitForTimeout(700);
  const state = await readLivePage(page);
  if (!state.rows.length || !state.categoryLeafSelected || state.categoryButtonCount !== 1) throw new Error('KOC_SOURCE_CATEGORY_SELECTION_NOT_CONFIRMED');
  if (!state.timeEvidence.some(line => /近30天数据/.test(line))) throw new Error('KOC_SOURCE_30_DAY_WINDOW_NOT_CONFIRMED');
  if (state.near30HasTradeControlCount !== 1 || state.near30HasTrade === null) throw new Error('KOC_SOURCE_NEAR30_TRADE_CONTROL_NOT_UNIQUE');

  if (state.near30HasTrade === true) {
    const checkbox = page.locator('label.el-checkbox').filter({hasText:/近30天有带货/});
    if (await checkbox.count() !== 1) throw new Error('KOC_SOURCE_NEAR30_TRADE_CONTROL_NOT_UNIQUE');
    await checkbox.click({timeout: 10000});
    await page.waitForTimeout(500);
  }
  const finalState = await readLivePage(page);
  if (finalState.near30HasTradeControlCount !== 1) throw new Error('KOC_SOURCE_NEAR30_TRADE_CONTROL_NOT_UNIQUE');
  if (finalState.near30HasTrade !== false) throw new Error('KOC_SOURCE_UNEXPECTED_NEAR30_TRADE_FILTER');
  if (!finalState.categoryLeafSelected || finalState.categoryButtonCount !== 1) throw new Error('KOC_SOURCE_CATEGORY_SELECTION_NOT_CONFIRMED');
  assertTargetBoard(finalState);
  return {state: finalState, evidence: {categoryPath: ['萌宠', '宠物猫'], selectedCategory: '宠物猫',
    selectedControl: finalState.selectedPetCatControls,
    categoryBreadcrumbs: finalState.petCatBreadcrumbs, categoryMenuCount:finalState.categoryMenuCount, selectedBoardType:'视频达人',
    categoryButtonCount:finalState.categoryButtonCount, boardTabGroupCount:finalState.boardTabGroupCount,
    videoBoardTabCount:finalState.videoBoardTabCount, selectedBoardControls:finalState.selectedBoardLabels,
    selectedCategoryTags:finalState.selectedCategoryTags, searchResponse:searchEvidence,
    timeEvidence: finalState.timeEvidence, near30HasTradeControlCount:finalState.near30HasTradeControlCount,
    near30HasTrade: finalState.near30HasTrade, subjectTypeHeaders:finalState.subjectTypeHeaders,
    businessSignalHeaders:finalState.businessSignalHeaders}};
}

function assertTargetBoard(state) {
  if (state.boardTabGroupCount !== 1 || state.videoBoardTabCount !== 1 || !state.selectedBoardLabels.includes('视频达人')) {
    throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_NOT_CONFIRMED');
  }
}

function assertPageScope(state, searchEvidence) {
  assertTargetBoard(state);
  if (state.rankingTableCount !== 1) throw new Error('KOC_SOURCE_RANKING_TABLE_NOT_UNIQUE');
  if (state.categoryButtonCount !== 1 || !state.categoryLeafSelected) throw new Error('KOC_SOURCE_CATEGORY_SELECTION_NOT_CONFIRMED');
  if (!state.timeEvidence.some(line => /所选类目下达人近30天数据/.test(line))) throw new Error('KOC_SOURCE_30_DAY_WINDOW_NOT_CONFIRMED');
  if (state.near30HasTradeControlCount !== 1) throw new Error('KOC_SOURCE_NEAR30_TRADE_CONTROL_NOT_UNIQUE');
  if (state.near30HasTrade !== false) throw new Error('KOC_SOURCE_UNEXPECTED_NEAR30_TRADE_FILTER');
  const requestConfirmsDescending = searchEvidence?.authorType === '2' &&
    searchEvidence?.sort === 'aweme_total_amount_30' && searchEvidence?.orderBy === 'desc';
  if (state.videoSalesDirection !== 'desc' && !requestConfirmsDescending) {
    throw new Error('KOC_SOURCE_VIDEO_SALES_UI_SORT_NOT_DESCENDING');
  }
}

async function selectVideoCreatorBoard(page, state) {
  if (state.rankingTableCount !== 1 || state.boardTabGroupCount !== 1 || state.videoBoardTabCount !== 1) {
    throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_NOT_UNIQUE');
  }
  const rankingTables = page.locator('table:visible,[role="table"]:visible').filter({hasText:/视频销售额/});
  if (await rankingTables.count() !== 1) throw new Error('KOC_SOURCE_RANKING_TABLE_NOT_UNIQUE');
  let tabGroups = page.locator('.el-tabs').filter({has:rankingTables});
  if (await tabGroups.count() !== 1) {
    tabGroups = page.locator('.search-result .tab-box').filter({hasText:/视频达人/});
  }
  if (await tabGroups.count() !== 1) throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_GROUP_NOT_UNIQUE');
  const controls = tabGroups.locator('[role="tab"],.el-tabs__item,.item').filter({hasText:/^\s*视频达人\s*$/});
  if (await controls.count() !== 1 || !(await controls.isEnabled())) throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_NOT_UNIQUE');
  if (state.selectedBoardLabels.includes('视频达人')) return state;
  const before = JSON.stringify(state.rows.map(row => row.cells));
  await controls.click({timeout:10000});
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const candidate = await readLivePage(page);
    if (candidate.selectedBoardLabels.includes('视频达人')) {
      if (!candidate.rows.length) throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_HAS_NO_ROWS');
      if (JSON.stringify(candidate.rows.map(row => row.cells)) === before) continue;
      return candidate;
    }
  }
  throw new Error('KOC_SOURCE_VIDEO_CREATOR_TAB_SELECTION_NOT_CONFIRMED');
}

async function sortVideoSalesDescending(page, pageSize, searchEvidence) {
  const header = page.locator('th,[role="columnheader"]').filter({hasText:/视频销售额/});
  const exactVisible = await header.evaluateAll(cells => cells.filter(cell => cell.getClientRects().length &&
    (cell.innerText || '').trim().replace(/\s+/g, ' ') === '视频销售额').length);
  if (exactVisible !== 1) throw new Error('KOC_SOURCE_VIDEO_SALES_HEADER_NOT_UNIQUE');

  let lastState=await readLivePage(page);
  let lastRows=normalizePageState(lastState,1,pageSize);
  const initialVerification=verifyDescendingByMetric(lastRows,'视频销售额');
  const requestConfirmsDescending = searchEvidence?.authorType === '2' &&
    searchEvidence?.sort === 'aweme_total_amount_30' && searchEvidence?.orderBy === 'desc';
  if (initialVerification.ok && requestConfirmsDescending) {
    return {state:lastState,rows:lastRows,clicks:0,attempts:[{click:0,verification:initialVerification,
      uiDirection:'desc',evidenceSource:'natural_author_search_request_and_visible_rows'}]};
  }
  if (initialVerification.ok && lastState.videoSalesDirection === 'desc') {
    return {state:lastState,rows:lastRows,clicks:0,attempts:[{click:0,verification:initialVerification,uiDirection:'desc'}]};
  }
  const attempts = [];
  for (let click = 1; click <= 2; click += 1) {
    const beforeFingerprint=JSON.stringify(lastState.rows.map(row=>row.cells));
    const beforeDirection=lastState.videoSalesDirection;
    await header.filter({visible:true}).click({timeout:10000});
    const deadline=Date.now()+12000;
    let changed=false;
    while (Date.now()<deadline) {
      await page.waitForTimeout(250);
      const candidate=await readLivePage(page);
      if (!candidate.rows.length) continue;
      const fingerprint=JSON.stringify(candidate.rows.map(row=>row.cells));
      const directionChanged=candidate.videoSalesDirection!==beforeDirection && !!candidate.videoSalesDirection;
      if (fingerprint===beforeFingerprint && !directionChanged) continue;
      changed=true;
      lastState=candidate;
      lastRows=normalizePageState(candidate,1,pageSize);
      const verification=verifyDescendingByMetric(lastRows,'视频销售额');
      if (verification.ok && candidate.videoSalesDirection === 'desc') {
        attempts.push({click,verification,uiDirection:candidate.videoSalesDirection,
          headerState:lastState.headerState.filter(item=>item.label==='视频销售额')});
        return {state:lastState,rows:lastRows,clicks:click,attempts};
      }
      break;
    }
    attempts.push({click,changed,uiDirection:lastState.videoSalesDirection,verification:verifyDescendingByMetric(lastRows,'视频销售额'),
      headerState:lastState.headerState.filter(item=>item.label==='视频销售额')});
    if (!changed) throw new Error('KOC_SOURCE_VIDEO_SALES_SORT_CONTROL_DID_NOT_CHANGE_ROWS');
  }
  throw new Error('KOC_SOURCE_VIDEO_SALES_DESCENDING_NOT_CONFIRMED');
}

function summaryFor(checkpoint, target) {
  const allRows = checkpoint.pages.flatMap(page => page.rows);
  const classification = classifyRankedRows(allRows);
  return {batchId: checkpoint.batchId, status: checkpoint.status, scope: SCOPE_LABEL,
    pagesCaptured: checkpoint.lastPage, visibleRows: checkpoint.rawRowCount,
    uniqueEligible: classification.eligible.length, excludedMerchants: classification.excluded.length,
    heldForReview: classification.review.length, duplicateRows: classification.duplicates.length,
    subjectEvidenceCoverage: classification.subjectEvidenceCoverage,
    targetCount: target, targetReached: checkpoint.targetReached === true,
    sourceComplete: checkpoint.sourceComplete === true,
    sortVerification: verifyDescendingByMetric(allRows, '视频销售额')};
}

async function main() {
  process.umask(0o077);
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const args = parseArgs(process.argv.slice(2));
  const batchId = args.resumeBatchId || makeBatchId();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(batchId)) throw new Error('KOC_SOURCE_BATCH_ID_INVALID');
  const checkpointPath = path.join(args.stateDir, `${batchId}.checkpoint.json`);
  const receiptPath = path.join(args.stateDir, `${batchId}.receipt.json`);
  let checkpoint;
    if (args.resumeBatchId) {
    checkpoint = await readPrivateJson(checkpointPath);
    assertResumableCheckpoint(checkpoint, {scopeKey: SCOPE_KEY});
    if (checkpoint.targetCount !== args.target) throw new Error('KOC_CHECKPOINT_TARGET_MISMATCH');
    if (args.maxPages < checkpoint.lastPage) throw new Error('KOC_CHECKPOINT_RESUME_PAGE_LIMIT_TOO_SMALL');
  } else {
    try {
      await fs.access(checkpointPath);
      throw new Error('KOC_CHECKPOINT_ALREADY_EXISTS_USE_RESUME');
    } catch (error) {
      if (error.message === 'KOC_CHECKPOINT_ALREADY_EXISTS_USE_RESUME') throw error;
      checkpoint = createCheckpoint({scopeKey: SCOPE_KEY, pageSize: 50, targetCount: args.target});
      checkpoint.batchId = batchId;
      checkpoint.scopeLabel = SCOPE_LABEL;
      checkpoint.headers = [];
      checkpoint.sortEvidence = null;
      checkpoint.filterEvidence = null;
    }
  }

  const saved = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  const storageState = createStorageState(saved, ORIGIN);
  let browser;
  let context;
  let page;
  let stage = 'launch';
  let sourceComplete = false;
  let targetReached = false;
  try {
    browser = await launchSourceBrowser(chromium);
    context = await browser.newContext({storageState});
    if (saved.storage?.session && typeof saved.storage.session === 'object') {
      await restoreSession(context, {origin:ORIGIN, storage:saved.storage.session}, ORIGIN);
    }
    page = await context.newPage();
    stage = 'open-ranking-page';
    const url = new URL(RANKING_URL);
    if (url.origin !== ORIGIN || url.pathname !== '/bloggerRank/' || url.search || url.hash) throw new Error('KOC_SOURCE_ROUTE_INVALID');
    await page.goto(url.href, {waitUntil:'domcontentloaded', timeout:30000});
    let state = await waitForRankingTable(page);
    if (state.origin !== ORIGIN || state.path !== '/bloggerRank/' || !/达人排行榜/.test(state.title)) throw new Error('KOC_SOURCE_RANKING_ROUTE_NOT_CONFIRMED');
    stage = 'select-video-creator-board';
    state = await selectVideoCreatorBoard(page, state);
    assertTargetBoard(state);
    if (state.currentPage && state.currentPage !== 1) throw new Error('KOC_SOURCE_START_PAGE_NOT_ONE');
    stage = 'select-pet-cat';
    const filter = await selectPetCat(page);
    state = filter.state;
    const pageSize = state.rows.length;
    if (pageSize !== 50) throw new Error('KOC_SOURCE_PAGE_SIZE_NOT_50');
    if (!checkpoint.pages.length) checkpoint.pageSize = pageSize;
    else if (checkpoint.pageSize !== pageSize) throw new Error('KOC_CHECKPOINT_PAGE_SIZE_MISMATCH');
    checkpoint.headers = state.headers;
    checkpoint.filterEvidence = filter.evidence;

    stage = 'sort-video-sales';
    const sort = await sortVideoSalesDescending(page, pageSize, filter.evidence.searchResponse);
    state = sort.state;
    assertTargetBoard(state);
    checkpoint.sortEvidence = {metric:'视频销售额', direction:'desc', uiDirection:'desc', header:'视频销售额', clicks:sort.clicks,
      evidenceSource:sort.attempts.at(-1)?.evidenceSource || 'visible_header_and_rows',
      attempts:sort.attempts, verification:sort.attempts.at(-1)?.verification, verified:true};

    const firstPage = 1;
    let currentPage = state.currentPage || 1;
    const storedPagesToRevalidate = checkpoint.lastPage;
    if (currentPage !== firstPage) throw new Error('KOC_SOURCE_PAGE_RESET_NOT_CONFIRMED');
    stage = 'capture-pages';
    for (let pageNumber = 1; pageNumber <= args.maxPages; pageNumber += 1) {
      if (pageNumber !== currentPage) throw new Error('KOC_SOURCE_PAGINATION_SEQUENCE_MISMATCH');
      assertPageScope(state, filter.evidence.searchResponse);
      const pageCapturedAt = new Date().toISOString();
      const rankedRows = normalizePageState(state, pageNumber, pageSize).map(row => ({...row, capturedAt:pageCapturedAt}));
      if (rankedRows.length !== pageSize && state.nextEnabled) throw new Error('KOC_SOURCE_UNEXPECTED_PAGE_ROW_COUNT');
      if (pageNumber <= checkpoint.lastPage) {
        const storedPage = checkpoint.pages.find(item => item.page === pageNumber);
        if (!storedPage || storedPage.fingerprint !== pageFingerprint(rankedRows)) throw new Error('KOC_CHECKPOINT_SOURCE_PAGE_CHANGED');
      } else {
        checkpoint = appendCheckpointPage(checkpoint, {page:pageNumber, rows:rankedRows, pageSize,
          capturedAt:pageCapturedAt, totalPages:state.totalPages});
        checkpoint.batchId = batchId;
        checkpoint.scopeLabel = SCOPE_LABEL;
        checkpoint.headers = state.headers;
        checkpoint.sortEvidence = {metric:'视频销售额', direction:'desc', uiDirection:'desc', header:'视频销售额', clicks:sort.clicks,
          evidenceSource:sort.attempts.at(-1)?.evidenceSource || 'visible_header_and_rows',
          attempts:sort.attempts, verification:sort.attempts.at(-1)?.verification, verified:true};
        checkpoint.filterEvidence = filter.evidence;
        await writePrivateJson(checkpointPath, checkpoint);
      }
      const allRows = checkpoint.pages.flatMap(item => item.rows);
      const classification = classifyRankedRows(allRows);
      const sortCheck = verifyDescendingByMetric(allRows, '视频销售额');
      if (!sortCheck.ok) throw new Error('KOC_SOURCE_CROSS_PAGE_SORT_NOT_CONFIRMED');
      if (classification.eligible.length >= args.target && pageNumber >= storedPagesToRevalidate) {
        targetReached = true;
        break;
      }
      const lastPage = !state.nextEnabled;
      if (lastPage) {
        sourceComplete = true;
        break;
      }
      if (pageNumber >= args.maxPages) break;

      stage = 'advance-ranking-page';
      const next = page.locator('.el-pagination button.btn-next:visible');
      if (await next.count() !== 1 || !(await next.isEnabled())) throw new Error('KOC_SOURCE_NEXT_PAGE_NOT_AVAILABLE');
      const before = rankedRows[0]?.creatorId || '';
      await next.click({timeout:10000});
      let advanced = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(250);
        const nextState = await readLivePage(page);
        if (nextState.loginRequired) throw new Error('KOC_SOURCE_LOGIN_REQUIRED');
        if (nextState.securityChallenge) throw new Error('KOC_SOURCE_SECURITY_CHALLENGE');
        if (nextState.menuDenied) throw new Error('KOC_SOURCE_MENU_DENIED');
        if (!nextState.rows.length) continue;
        const nextRows = normalizePageState(nextState, pageNumber + 1, pageSize);
        const expectedPage = nextState.currentPage === pageNumber + 1 || (!nextState.currentPage && nextRows[0]?.creatorId && nextRows[0].creatorId !== before);
        if (expectedPage && nextRows.length) {
          assertPageScope(nextState, filter.evidence.searchResponse);
          state = nextState;
          currentPage = pageNumber + 1;
          advanced = true;
          break;
        }
      }
      if (!advanced) throw new Error('KOC_SOURCE_NEXT_PAGE_DID_NOT_ADVANCE');
    }

    const completeStatus = targetReached ? 'target_reached' : sourceComplete ? 'source_exhausted' : 'partial';
    checkpoint = finishCheckpoint(checkpoint, {status:completeStatus, targetReached, sourceComplete,
      finishedAt:new Date().toISOString()});
    await writePrivateJson(checkpointPath, checkpoint);
    const summary = summaryFor(checkpoint, args.target);
    const receipt = {version:1, batchId, status:checkpoint.status, scope:SCOPE_LABEL,
      startedAt:checkpoint.startedAt, finishedAt:checkpoint.finishedAt, pagesCaptured:checkpoint.lastPage,
      visibleRows:checkpoint.rawRowCount, targetCount:args.target, targetReached, sourceComplete,
      excludedMerchantCount:summary.excludedMerchants, heldForReviewCount:summary.heldForReview,
      duplicateRowCount:summary.duplicateRows, sortVerification:summary.sortVerification,
      filterEvidence:checkpoint.filterEvidence, sortEvidence:checkpoint.sortEvidence,
      subjectEvidenceCoverage:summary.subjectEvidenceCoverage,
      checkpointPath};
    await writePrivateJson(receiptPath, receipt);
    console.log(JSON.stringify({passed:true, summary, receiptPath}));
  } catch (error) {
    const reason = /^KOC_[A-Z0-9_:.\-]+$/.test(error?.message || '') ? error.message.split(':')[0] : `KOC_SOURCE_FAILED_AT_${stage.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}`;
    if (checkpoint) {
      checkpoint = {...checkpoint, status:'partial', failureReason:reason, failedAt:new Date().toISOString()};
      await writePrivateJson(checkpointPath, checkpoint).catch(() => {});
    }
    console.log(JSON.stringify({passed:false, stage, reason, batchId, pagesCaptured:checkpoint?.lastPage || 0,
      sourceState:error?.safeState,
      checkpointPath:checkpoint ? checkpointPath : undefined}));
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
