export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      game_types: {
        Row: {
          id: string
          name: string
          description: string
          created_at: string | null
        }
        Insert: {
          id?: string
          name: string
          description: string
          created_at?: string | null
        }
        Update: {
          id?: string
          name?: string
          description?: string
          created_at?: string | null
        }
      }
      scenarios: {
        Row: {
          id: string
          game_type_id: string
          title: string
          description: string
          difficulty: string | null
          duration_minutes: number | null
          created_at: string | null
          image_url: string | null
        }
        Insert: {
          id?: string
          game_type_id: string
          title: string
          description: string
          difficulty?: string | null
          duration_minutes?: number | null
          created_at?: string | null
          image_url?: string | null
        }
        Update: {
          id?: string
          game_type_id?: string
          title?: string
          description?: string
          difficulty?: string | null
          duration_minutes?: number | null
          created_at?: string | null
          image_url?: string | null
        }
      }
      launched_games: {
        Row: {
          id: number
          game_uniqid: string
          name: string
          number_of_teams: number
          game_type: string
          start_time: string
          ended: boolean
          started: boolean
          duration: number
          created_at: string | null
        }
        Insert: {
          id?: number
          game_uniqid: string
          name: string
          number_of_teams: number
          game_type: string
          start_time: string
          ended?: boolean
          started?: boolean
          duration: number
          created_at?: string | null
        }
        Update: {
          id?: number
          game_uniqid?: string
          name?: string
          number_of_teams?: number
          game_type?: string
          start_time?: string
          ended?: boolean
          started?: boolean
          duration?: number
          created_at?: string | null
        }
      }
      launched_game_meta: {
        Row: {
          id: number
          meta_name: string
          meta_value: string | null
          launched_game_id: number
          created_at: string | null
        }
        Insert: {
          id?: number
          meta_name: string
          meta_value?: string | null
          launched_game_id: number
          created_at?: string | null
        }
        Update: {
          id?: number
          meta_name?: string
          meta_value?: string | null
          launched_game_id?: number
          created_at?: string | null
        }
      }
      si_puces: {
        Row: {
          id: number
          created_at: string
          updated_at: string
          key_name: string
          key_number: number
          color: string | null
        }
        Insert: {
          id: number
          created_at: string
          updated_at: string
          key_name: string
          key_number: number
          color?: string | null
        }
        Update: {
          id?: number
          created_at?: string
          updated_at?: string
          key_name?: string
          key_number?: number
          color?: string | null
        }
      }
      teams: {
        Row: {
          id: number
          launched_game_id: number
          team_number: number
          team_name: string
          pattern: number
          score: number
          key_id: number
          start_time: number | null
          end_time: number | null
        }
        Insert: {
          id?: number
          launched_game_id: number
          team_number: number
          team_name: string
          pattern: number
          score: number
          key_id: number
          start_time?: number | null
          end_time?: number | null
        }
        Update: {
          id?: number
          launched_game_id?: number
          team_number?: number
          team_name?: string
          pattern?: number
          score?: number
          key_id?: number
          start_time?: number | null
          end_time?: number | null
        }
      }
    }
  }
}

export type GameType = Database['public']['Tables']['game_types']['Row'];
export type Scenario = Database['public']['Tables']['scenarios']['Row'];
export type LaunchedGame = Database['public']['Tables']['launched_games']['Row'];
export type LaunchedGameMeta = Database['public']['Tables']['launched_game_meta']['Row'];
export type SiPuce = Database['public']['Tables']['si_puces']['Row'];
export type Team = Database['public']['Tables']['teams']['Row'];
