export const PLAYWRIGHT_CLI_VERSION='0.1.21';
export const PLAYWRIGHT_CLI_PACKAGE=`@playwright/cli@${PLAYWRIGHT_CLI_VERSION}`;

export function playwrightCliArgs(...args){
  return ['--no-install',PLAYWRIGHT_CLI_PACKAGE,...args];
}

export function playwrightCliEnv(environment=process.env){
  return {...environment,DEBUG:'',PWDEBUG:'',NO_UPDATE_NOTIFIER:'1'};
}
