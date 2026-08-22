export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      admin_bootstrap: {
        Row: {
          email: string
        }
        Insert: {
          email: string
        }
        Update: {
          email?: string
        }
        Relationships: []
      }
      answers: {
        Row: {
          id: string
          is_correct: boolean
          marks_awarded: number
          question_id: string
          round_id: string
          selected_option_id: string | null
          submitted_at: string
          user_id: string
        }
        Insert: {
          id?: string
          is_correct?: boolean
          marks_awarded?: number
          question_id: string
          round_id: string
          selected_option_id?: string | null
          submitted_at?: string
          user_id: string
        }
        Update: {
          id?: string
          is_correct?: boolean
          marks_awarded?: number
          question_id?: string
          round_id?: string
          selected_option_id?: string | null
          submitted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_selected_option_id_fkey"
            columns: ["selected_option_id"]
            isOneToOne: false
            referencedRelation: "question_options"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json
          resource: string
          resource_id: string
        }
        Insert: {
          action: string
          actor_email?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          resource?: string
          resource_id?: string
        }
        Update: {
          action?: string
          actor_email?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          resource?: string
          resource_id?: string
        }
        Relationships: []
      }
      batches: {
        Row: {
          academic_year: string
          active: boolean
          batch_number: string
          created_at: string
          department: string
          id: string
          name: string
        }
        Insert: {
          academic_year?: string
          active?: boolean
          batch_number: string
          created_at?: string
          department?: string
          id?: string
          name?: string
        }
        Update: {
          academic_year?: string
          active?: boolean
          batch_number?: string
          created_at?: string
          department?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      code_submissions: {
        Row: {
          code: string
          created_at: string
          execution_ms: number
          id: string
          language: string
          message: string
          passed_tests: number
          problem_id: string
          round_id: string
          score: number
          status: Database["public"]["Enums"]["submission_status"]
          total_tests: number
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          execution_ms?: number
          id?: string
          language: string
          message?: string
          passed_tests?: number
          problem_id: string
          round_id: string
          score?: number
          status?: Database["public"]["Enums"]["submission_status"]
          total_tests?: number
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          execution_ms?: number
          id?: string
          language?: string
          message?: string
          passed_tests?: number
          problem_id?: string
          round_id?: string
          score?: number
          status?: Database["public"]["Enums"]["submission_status"]
          total_tests?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_submissions_problem_id_fkey"
            columns: ["problem_id"]
            isOneToOne: false
            referencedRelation: "problems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_submissions_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          description: string
          end_at: string | null
          id: string
          max_participants: number
          name: string
          results_published: boolean
          start_at: string | null
          status: Database["public"]["Enums"]["event_status"]
        }
        Insert: {
          created_at?: string
          description?: string
          end_at?: string | null
          id?: string
          max_participants?: number
          name: string
          results_published?: boolean
          start_at?: string | null
          status?: Database["public"]["Enums"]["event_status"]
        }
        Update: {
          created_at?: string
          description?: string
          end_at?: string | null
          id?: string
          max_participants?: number
          name?: string
          results_published?: boolean
          start_at?: string | null
          status?: Database["public"]["Enums"]["event_status"]
        }
        Relationships: []
      }
      languages: {
        Row: {
          code: string
          enabled: boolean
          executable: boolean
          id: string
          name: string
          starter_code: string
        }
        Insert: {
          code: string
          enabled?: boolean
          executable?: boolean
          id?: string
          name: string
          starter_code?: string
        }
        Update: {
          code?: string
          enabled?: boolean
          executable?: boolean
          id?: string
          name?: string
          starter_code?: string
        }
        Relationships: []
      }
      problems: {
        Row: {
          allowed_languages: string[]
          constraints: string
          created_at: string
          description: string
          difficulty: string
          enabled: boolean
          examples: Json
          id: string
          input_format: string
          max_marks: number
          memory_limit_mb: number
          order_index: number
          output_format: string
          round_id: string
          time_limit_ms: number
          title: string
        }
        Insert: {
          allowed_languages?: string[]
          constraints?: string
          created_at?: string
          description?: string
          difficulty?: string
          enabled?: boolean
          examples?: Json
          id?: string
          input_format?: string
          max_marks?: number
          memory_limit_mb?: number
          order_index?: number
          output_format?: string
          round_id: string
          time_limit_ms?: number
          title: string
        }
        Update: {
          allowed_languages?: string[]
          constraints?: string
          created_at?: string
          description?: string
          difficulty?: string
          enabled?: boolean
          examples?: Json
          id?: string
          input_format?: string
          max_marks?: number
          memory_limit_mb?: number
          order_index?: number
          output_format?: string
          round_id?: string
          time_limit_ms?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "problems_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          batch_number: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          phone: string | null
          student_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          batch_number?: string | null
          created_at?: string
          email: string
          full_name: string
          id: string
          phone?: string | null
          student_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          batch_number?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          phone?: string | null
          student_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      question_options: {
        Row: {
          id: string
          is_correct: boolean
          option_text: string
          order_index: number
          question_id: string
        }
        Insert: {
          id?: string
          is_correct?: boolean
          option_text: string
          order_index?: number
          question_id: string
        }
        Update: {
          id?: string
          is_correct?: boolean
          option_text?: string
          order_index?: number
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_options_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          created_at: string
          explanation: string
          id: string
          marks: number
          order_index: number
          question_text: string
          round_id: string
          visible: boolean
        }
        Insert: {
          created_at?: string
          explanation?: string
          id?: string
          marks?: number
          order_index?: number
          question_text: string
          round_id: string
          visible?: boolean
        }
        Update: {
          created_at?: string
          explanation?: string
          id?: string
          marks?: number
          order_index?: number
          question_text?: string
          round_id?: string
          visible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "questions_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      round_progress: {
        Row: {
          answered_count: number
          completed_at: string | null
          ends_at: string | null
          id: string
          round_id: string
          score: number
          started_at: string
          status: Database["public"]["Enums"]["progress_status"]
          user_id: string
        }
        Insert: {
          answered_count?: number
          completed_at?: string | null
          ends_at?: string | null
          id?: string
          round_id: string
          score?: number
          started_at?: string
          status?: Database["public"]["Enums"]["progress_status"]
          user_id: string
        }
        Update: {
          answered_count?: number
          completed_at?: string | null
          ends_at?: string | null
          id?: string
          round_id?: string
          score?: number
          started_at?: string
          status?: Database["public"]["Enums"]["progress_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "round_progress_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      rounds: {
        Row: {
          created_at: string
          description: string
          duration_minutes: number
          enabled: boolean
          end_at: string | null
          event_id: string
          id: string
          max_marks: number
          name: string
          order_index: number
          round_type: Database["public"]["Enums"]["round_type"]
          start_at: string | null
          status: Database["public"]["Enums"]["round_status"]
        }
        Insert: {
          created_at?: string
          description?: string
          duration_minutes?: number
          enabled?: boolean
          end_at?: string | null
          event_id: string
          id?: string
          max_marks?: number
          name: string
          order_index?: number
          round_type?: Database["public"]["Enums"]["round_type"]
          start_at?: string | null
          status?: Database["public"]["Enums"]["round_status"]
        }
        Update: {
          created_at?: string
          description?: string
          duration_minutes?: number
          enabled?: boolean
          end_at?: string | null
          event_id?: string
          id?: string
          max_marks?: number
          name?: string
          order_index?: number
          round_type?: Database["public"]["Enums"]["round_type"]
          start_at?: string | null
          status?: Database["public"]["Enums"]["round_status"]
        }
        Relationships: [
          {
            foreignKeyName: "rounds_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      test_cases: {
        Row: {
          expected_output: string
          id: string
          input: string
          is_public: boolean
          order_index: number
          problem_id: string
          weight: number
        }
        Insert: {
          expected_output?: string
          id?: string
          input?: string
          is_public?: boolean
          order_index?: number
          problem_id: string
          weight?: number
        }
        Update: {
          expected_output?: string
          id?: string
          input?: string
          is_public?: boolean
          order_index?: number
          problem_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "test_cases_problem_id_fkey"
            columns: ["problem_id"]
            isOneToOne: false
            referencedRelation: "problems"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      violations: {
        Row: {
          created_at: string
          details: string
          event_id: string | null
          id: string
          round_id: string | null
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: string
          event_id?: string | null
          id?: string
          round_id?: string | null
          type: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: string
          event_id?: string | null
          id?: string
          round_id?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "violations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "violations_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "student"
      event_status: "draft" | "upcoming" | "active" | "completed"
      progress_status: "not_started" | "in_progress" | "completed" | "expired"
      round_status: "upcoming" | "live" | "completed" | "locked"
      round_type: "mcq" | "coding"
      submission_status:
        | "pending"
        | "running"
        | "accepted"
        | "wrong_answer"
        | "compilation_error"
        | "runtime_error"
        | "time_limit_exceeded"
        | "memory_limit_exceeded"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "student"],
      event_status: ["draft", "upcoming", "active", "completed"],
      progress_status: ["not_started", "in_progress", "completed", "expired"],
      round_status: ["upcoming", "live", "completed", "locked"],
      round_type: ["mcq", "coding"],
      submission_status: [
        "pending",
        "running",
        "accepted",
        "wrong_answer",
        "compilation_error",
        "runtime_error",
        "time_limit_exceeded",
        "memory_limit_exceeded",
      ],
    },
  },
} as const
