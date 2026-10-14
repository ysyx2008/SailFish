/**
 * 本地联系人领域门面：秘书的 contact_* 工具和联系人页都经它读写，
 * 「可能是同一个人」只在这里判一次。
 */
import type {
  Contact,
  ContactAddOptions,
  ContactAddResult,
  ContactCreateInput,
  ContactDeleteResult,
  ContactUpdatePatch,
  ContactUpdateResult,
} from '@sailfish/shared-types'
import {
  applyContactUpdate,
  createContact,
  findPossibleSamePeople,
  loadStore,
  mutateStore,
  searchContacts,
} from './store'

export class ContactBook {
  list(): Contact[] {
    return loadStore().contacts
  }

  search(query: string): Contact[] {
    return searchContacts(loadStore().contacts, query)
  }

  /** 同名常见，不拦；但没确认是另一个人之前，先把可能是同一个人的带回去 */
  async add(input: ContactCreateInput, options: ContactAddOptions = {}): Promise<ContactAddResult> {
    const name = input.name.trim()
    return mutateStore(store => {
      if (!options.confirmedDifferent) {
        const candidates = findPossibleSamePeople(store.contacts, { ...input, name })
        if (candidates.length > 0) return { type: 'possibleSame', candidates }
      }
      const contact = createContact({ ...input, name })
      store.contacts.push(contact)
      return { type: 'created', contact }
    })
  }

  async update(id: string, patch: ContactUpdatePatch): Promise<ContactUpdateResult> {
    return mutateStore(store => {
      const index = store.contacts.findIndex(item => item.id === id)
      if (index < 0) return { type: 'missing' }
      const next = applyContactUpdate(store.contacts[index], patch)
      store.contacts[index] = next
      return { type: 'updated', contact: next }
    })
  }

  async remove(id: string): Promise<ContactDeleteResult> {
    return mutateStore(store => {
      const index = store.contacts.findIndex(item => item.id === id)
      if (index < 0) return { type: 'missing' }
      const [contact] = store.contacts.splice(index, 1)
      return { type: 'deleted', contact }
    })
  }
}

let instance: ContactBook | null = null

export function getContactBook(): ContactBook {
  if (!instance) instance = new ContactBook()
  return instance
}
