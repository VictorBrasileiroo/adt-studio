import { createContext, useContext } from "react"
import { apiSetupClient, type SetupClient } from "./client"

const SetupClientContext = createContext<SetupClient>(apiSetupClient)

/** Defaults to the API client; tests and isolated development can pass a fake. */
export const SetupClientProvider = SetupClientContext.Provider

export function useSetupClient(): SetupClient {
  return useContext(SetupClientContext)
}
