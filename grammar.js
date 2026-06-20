FUNCTION z_get_mail_address.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(P_CONTRACT) TYPE  VKONT_KK OPTIONAL
*"  EXPORTING
*"     REFERENCE(FULL_DATA) TYPE  ZST_POWER_BILL_ADDRESS
*"----------------------------------------------------------------------
  "--- Static tables are filled from the DB only once per session.
  STATICS:
    st_prefix_loaded         TYPE abap_bool,
    st_suffix_loaded         TYPE abap_bool,
    st_sec_unit_desig_loaded TYPE abap_bool,
    st_prefix                TYPE HASHED TABLE OF zstreetprefix WITH UNIQUE KEY id,
    st_suffix                TYPE HASHED TABLE OF zstreetsuffix WITH UNIQUE KEY id,
    st_secunitdesig          TYPE HASHED TABLE OF zsecunitdesig WITH UNIQUE KEY id.

  DATA: lt_words                    TYPE TABLE OF string,
        lv_raw_second_unit          TYPE string,
        lt_second_unit_words        TYPE TABLE OF string,
        lt_second_unit_number_parts TYPE TABLE OF string,
        st_eadrdat                  TYPE eadrdat.

  DATA: it_addressdata LIKE isuaccaddrdata OCCURS 1 WITH HEADER LINE,
        wa_addressdata LIKE isuaccaddrdata.

  CLEAR full_data.

  " Load prefixes into memory
  IF st_prefix_loaded = abap_false.
    SELECT * FROM zstreetprefix INTO TABLE @st_prefix.
    st_prefix_loaded = abap_true.
  ENDIF.

  " Load suffixes into memory
  IF st_suffix_loaded = abap_false.
    SELECT * FROM zstreetsuffix INTO TABLE @st_suffix.
    st_suffix_loaded = abap_true.
  ENDIF.

  " Load secondary unit designators into memory
  IF st_sec_unit_desig_loaded = abap_false.
    SELECT * FROM zsecunitdesig INTO TABLE @st_secunitdesig.
    st_sec_unit_desig_loaded = abap_true.
  ENDIF.


  IF p_contract IS NOT INITIAL.

    CALL FUNCTION 'ISU_GET_ACC_ADRESS_DATA'
      EXPORTING
        x_doc_type     = '2'
        x_vkont        = p_contract
      TABLES
        yt_addressdata = it_addressdata
      EXCEPTIONS
        not_found      = 1
        OTHERS         = 2.
    READ TABLE it_addressdata INTO wa_addressdata INDEX 1.
    IF sy-subrc = 0.
      DATA(lv_addrnumber) =  wa_addressdata-addrnumber.
      DATA(lv_perno) = wa_addressdata-persnumber.
    ENDIF.

    SELECT SINGLE * FROM  adrc
     INTO @DATA(st_adrc)
      WHERE  addrnumber  = @lv_addrnumber.

    SELECT SINGLE gpart FROM fkkvkp
      INTO @DATA(lv_bp_number)
      WHERE vkont = @p_contract.

    IF sy-subrc = 0.

      full_data-vkont = p_contract.

      SELECT name_org1, name_last, name_first, name_grp1
        INTO TABLE @DATA(it_name) UP TO 1 ROWS
        FROM but000
        WHERE partner = @lv_bp_number
        ORDER BY PRIMARY KEY.

      "---  Get the Full Name/Company Name
      LOOP AT it_name ASSIGNING FIELD-SYMBOL(<fs_name>).
        DATA(lv_full_name) = COND #( WHEN <fs_name>-name_org1 IS NOT INITIAL
                                     THEN <fs_name>-name_org1
                                     WHEN <fs_name>-name_org1 IS INITIAL AND <fs_name>-name_last IS NOT INITIAL
                                     THEN |{ <fs_name>-name_first } { <fs_name>-name_last }|
                                     ELSE  <fs_name>-name_org1 ).

        full_data-full_name = lv_full_name.

      ENDLOOP.

      CALL FUNCTION 'ISU_ADDRESS_PROVIDE'
        EXPORTING
          x_address_type = 'A' " T = Standard Address (Mailing Address)
          x_partner      = lv_bp_number
          x_account      = p_contract
          x_addrnumber   = lv_addrnumber
          x_persnumber   = lv_perno
        IMPORTING
          y_eadrdat      = st_eadrdat
        EXCEPTIONS
          OTHERS         = 1.
    ENDIF.
  ELSE.
    " Handle case where no contract is provided, if necessary.
    RETURN.
  ENDIF.

  " If address retrieval failed, exit the function.
  IF sy-subrc <> 0 OR st_eadrdat IS INITIAL.
    RETURN.
  ENDIF.

  "--- Fill basic address fields first ---
  full_data-city     = st_eadrdat-city1.
  full_data-state    = st_eadrdat-region.
  full_data-zip_code = st_eadrdat-post_code1.

  " CO
  IF st_adrc-name_co IS NOT INITIAL.
    full_data-name_co = st_adrc-name_co.
  ENDIF.

  "--- NEW: P.O. Box Validation ---
  IF st_eadrdat-po_box IS NOT INITIAL.
    " This is a P.O. Box address. Bypass street parsing.
    full_data-po_box  = |P.O. BOX { st_eadrdat-po_box }|.

    IF st_eadrdat-po_box_cty IS NOT INITIAL.
      full_data-city     = st_eadrdat-po_box_cty.
    ENDIF.

    full_data-zip_code = st_eadrdat-post_code2.
    "  house_number = st_eadrdat-po_box.
    " No prefix, suffix, or unit number for a PO Box.
    RETURN. " Exit function as processing is complete.
  ENDIF.

  "--- Street Parsing Logic (only if it's not a PO Box) ---
  DATA(lv_street) = st_eadrdat-street.
  TRANSLATE lv_street TO UPPER CASE.
  REPLACE ALL OCCURRENCES OF REGEX '[.,]' IN lv_street WITH space.
  CONDENSE lv_street.

  SPLIT lv_street AT space INTO TABLE lt_words.
  DELETE lt_words WHERE table_line IS INITIAL.

  IF lt_words IS INITIAL.
    full_data-street_name = lv_street.
  ELSE.
    DATA(lv_first_word) = lt_words[ 1 ].
    READ TABLE st_prefix ASSIGNING FIELD-SYMBOL(<fs_prefix>) WITH KEY description = lv_first_word.
    IF sy-subrc <> 0.
      READ TABLE st_prefix ASSIGNING <fs_prefix> WITH KEY prefix = lv_first_word.
    ENDIF.
    IF sy-subrc = 0.
      full_data-street_prefix = <fs_prefix>-prefix.
      DELETE lt_words INDEX 1.
    ENDIF.

    IF lt_words IS NOT INITIAL.
      DATA(lv_last_word) = lt_words[ lines( lt_words ) ].
      READ TABLE st_suffix ASSIGNING FIELD-SYMBOL(<fs_suffix>) WITH KEY description = lv_last_word.
      IF sy-subrc <> 0.
        READ TABLE st_suffix ASSIGNING <fs_suffix> WITH KEY suffix = lv_last_word.
      ENDIF.
      IF sy-subrc = 0.
        full_data-street_suffix = <fs_suffix>-suffix.
        DELETE lt_words INDEX lines( lt_words ).
      ENDIF.
    ENDIF.

    IF lt_words IS NOT INITIAL.
      CONCATENATE LINES OF lt_words INTO full_data-street_name SEPARATED BY space.
    ELSE.
      CLEAR full_data-street_name.
    ENDIF.
  ENDIF.

  full_data-house_number = st_eadrdat-house_num1.

  " Use the correct variable for the secondary unit.
  lv_raw_second_unit = COND #( WHEN st_eadrdat-haus_num2_vbs IS NOT INITIAL
                               THEN st_eadrdat-haus_num2_vbs
                               ELSE st_eadrdat-house_num2 ).

  "--- Parse the Secondary Unit Designator and Number ---
  IF lv_raw_second_unit IS NOT INITIAL.
    TRANSLATE lv_raw_second_unit TO UPPER CASE.
    CONDENSE lv_raw_second_unit.

    SPLIT lv_raw_second_unit AT space INTO TABLE lt_second_unit_words.

    LOOP AT lt_second_unit_words ASSIGNING FIELD-SYMBOL(<fs_word>).
      READ TABLE st_secunitdesig ASSIGNING FIELD-SYMBOL(<fs_desig>) WITH KEY designator = <fs_word>.
      IF sy-subrc <> 0.
        READ TABLE st_secunitdesig ASSIGNING <fs_desig> WITH KEY abbreviation = <fs_word>.
      ENDIF.

      IF sy-subrc = 0.
        full_data-2nd_unit_desc = <fs_desig>-abbreviation.
      ELSE.
        APPEND <fs_word> TO lt_second_unit_number_parts.
      ENDIF.
    ENDLOOP.

    IF lt_second_unit_number_parts IS NOT INITIAL.
      CONCATENATE LINES OF lt_second_unit_number_parts INTO full_data-2nd_unit_number. " No separator needed
      REPLACE ALL OCCURRENCES OF '#' IN full_data-2nd_unit_number WITH ''.
      CONDENSE full_data-2nd_unit_number.
    ENDIF.
  ENDIF.

ENDFUNCTION.

